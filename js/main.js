/**
 * main.js — bootstrap and wiring.
 *
 * Owns the three-step entrance (choose → set up → connect), the waiting room, and
 * the transition into the movie. Connects every module to the others and holds no
 * sync logic of its own; that all lives in sync.js.
 *
 * The session has two phases, and almost every UI decision here keys off them:
 *
 *   'lobby'   — everyone is gathering. Chat, reactions, cameras and the roster are
 *               live; playback controls are inert. The host decides when this ends.
 *   'playing' — the movie is running. Someone arriving now has to knock.
 */

import { connect } from './net.js';
import { createSync } from './sync.js';
import { preflight, fingerprint, attach, remuxCommand, formatTime } from './player.js';
import { loadSubtitles, toggleSubtitles, styleSubtitles, setSubLift, hasSubtitles } from './subs.js';
import { startCall } from './call.js';
import { createChat } from './chat.js';
import {
  autoHideControls, toggleFullscreen, bindKeys, bindKeyUp, banner,
  centerStatus, bindPanelCloses, bindDismissOnOutside, closeOtherPanels,
} from './ui.js';
// Starts itself on import and mounts at body level. We only tell it when to
// move into #stage and when to go away for good.
import * as frames from './frames.js';

const $ = id => document.getElementById(id);

/**
 * How long to wait for ANY peer before declaring a room empty.
 *
 * Generous on purpose. Nostr discovery through Trystero routinely takes the best
 * part of ten seconds, and telling someone a real room doesn't exist is a much
 * worse failure than making them wait an extra moment — hence this number, and
 * hence the "Try again" button on the other side of it.
 */
const ROOM_PROBE_MS = 12_000;

/** After a peer answers, how long to wait for the room state to come back. */
const PHASE_WAIT_MS = 5000;

/** How long a knocker waits before we offer to ask again. We keep listening. */
const KNOCK_PATIENCE_MS = 45_000;

/** Panels that close when you click away from them. */
const PANELS = ['chatPanel', 'settingsPanel', 'rosterPanel', 'emojiPicker'];

// ═══════════════════════════ entrance ═══════════════════════════

const CARDS = ['landingCard', 'setupCard', 'statusCard'];
const showCard = id => CARDS.forEach(c => ($(c).hidden = c !== id));

/** 'create' or 'join'. Decides the copy, and whether we check the room exists. */
let mode = 'create';

let movieFile = null;
let movieFp = null;
let subFile = null;

const params = new URLSearchParams(location.search);
const urlRoom = params.get('room');

$('displayName').value = localStorage.getItem('mw:name') || '';

$('createChoice').addEventListener('click', () => enterSetup('create'));
$('joinChoice').addEventListener('click', () => enterSetup('join'));
$('setupBack').addEventListener('click', () => showCard('landingCard'));

function enterSetup(m) {
  mode = m;
  const creating = m === 'create';

  $('setupTitle').textContent = creating ? 'Create a room' : 'Join a room';
  $('setupTagline').textContent = creating
    ? 'Pick your movie, then share the link with everyone else.'
    : 'Enter the code you were sent, and pick your copy of the movie.';
  $('joinBtn').textContent = creating ? 'Create room' : 'Join room';
  $('setupBack').hidden = false;

  // Creating defaults to the last code used (a group that watches together every
  // week keeps the same link) and falls back to a fresh one. Joining starts empty
  // unless a link supplied the code.
  $('roomCode').value = urlRoom
    || (creating ? (localStorage.getItem('mw:room') || randomRoom()) : '');

  updateShareHint();
  showCard('setupCard');
}

$('roomCode').addEventListener('input', updateShareHint);

function updateShareHint() {
  const code = $('roomCode').value.trim();
  $('shareHint').textContent = code ? `Share: ${shareLink(code)}` : '';
}

function shareLink(code) {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

$('copyLink').addEventListener('click', () => copyLink($('roomCode').value.trim(), $('copyLink')));

async function copyLink(code, btn) {
  if (!code) return;
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(shareLink(code));
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = label), 1600);
  } catch {
    $('shareHint').textContent = shareLink(code);
  }
}

$('videoFile').addEventListener('change', async () => {
  const file = $('videoFile').files[0];
  if (!file) return;

  movieFile = null;
  movieFp = null;
  $('joinBtn').disabled = true;
  setStatus($('videoStatus'), '', 'Checking whether the browser can play this…');

  const result = await preflight(file);

  if (!result.ok) {
    setStatus(
      $('videoStatus'), 'err',
      `${result.reason}\n\nConvert it first — this is fast and lossless:`,
      result.fix || remuxCommand(file.name)
    );
    return;
  }

  movieFile = file;
  setStatus($('videoStatus'), '', 'Fingerprinting…');
  movieFp = await fingerprint(file);

  const summary = `${file.name} — ${formatTime(result.duration)}, ${(file.size / 1e9).toFixed(2)} GB`;

  if (result.audioWarning) {
    // Playable, but probably silent. Let them continue — they may know it's silent.
    setStatus(
      $('videoStatus'), 'warn',
      `${summary}\n\n${result.audioWarning.reason}\n\nTo fix the audio:`,
      result.audioWarning.fix
    );
  } else {
    setStatus($('videoStatus'), 'ok', summary);
  }

  $('joinBtn').disabled = false;
});

$('subFile').addEventListener('change', () => {
  subFile = $('subFile').files[0] || null;
  if (subFile) setStatus($('subStatus'), 'ok', `${subFile.name} — only you will see these`);
});

function setStatus(el, cls, text, code) {
  // Swap only the state class. This used to assign el.className outright,
  // which silently wiped any other class the markup put on the element.
  el.classList.remove('ok', 'warn', 'err');
  if (cls) el.classList.add(cls);
  el.textContent = text;
  if (code) {
    const c = document.createElement('code');
    c.textContent = code;
    el.appendChild(c);
  }
}

$('joinBtn').addEventListener('click', () => {
  const room = $('roomCode').value.trim();
  if (!room) return showLobbyError('Enter a room code first.');
  if (!movieFile) return showLobbyError('Choose a movie file first.');

  localStorage.setItem('mw:room', room);
  localStorage.setItem('mw:name', $('displayName').value.trim());
  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);

  $('lobbyError').hidden = true;
  startSession(room).catch(err => {
    showCard('setupCard');
    showLobbyError(err.message || String(err));
  });
});

function showLobbyError(msg) {
  $('lobbyError').textContent = msg;
  $('lobbyError').hidden = false;
}

function randomRoom() {
  return 'movie-' + Math.random().toString(36).slice(2, 8);
}

/**
 * A shared link goes straight to the join form.
 *
 * "Click a link and it works" is the whole product. Making someone who was sent a
 * room link stop and choose between Create and Join is exactly the wrong question
 * to ask them — they already know which one they are doing.
 *
 * Deliberately the LAST statement in this section. Called any earlier it runs
 * before the helpers it reaches — `shareLink`, `randomRoom` — have initialised,
 * and a `const` in its temporal dead zone throws where a plain function would not.
 */
if (urlRoom) enterSetup('join');

/** The connecting / not-found / knocking card. */
function showConnStatus({ title, body = '', spinner = true, actions = null, retryLabel = 'Try again' }) {
  $('statusTitle').textContent = title;
  $('statusBody').textContent = body;
  $('statusSpinner').hidden = !spinner;
  $('statusActions').hidden = !actions;
  $('statusRetry').hidden = !actions?.retry;
  $('statusRetry').textContent = retryLabel;
  $('statusRetry').onclick = actions?.retry || null;
  $('statusBack').onclick = actions?.back || null;
  showCard('statusCard');
}

// ═══════════════════════════ session ═══════════════════════════

async function startSession(roomCode) {
  const stage = $('stage');
  const video = $('movie');
  const banners = $('banners');
  const myName = $('displayName').value.trim() || 'Guest';

  /** 'lobby' until the host starts the film. */
  let phase = 'lobby';

  /** Host policy. Mirrored from the host's `phase` messages when we are not it. */
  const policy = { control: 'everyone', allowLate: true };

  /** Have we been let into the room? False only while knocking at a started movie. */
  let admitted = false;

  /** Set once the stage is up and the modules exist. */
  let sync = null;
  let chat = null;
  let call = null;
  let duck = null;

  /**
   * When the camera last went on, so a connection failure can be attributed to it.
   *
   * Declared up here rather than beside the camera code because `admit()` runs
   * before that point in the file and writes to it — a `let` further down would
   * still be in its temporal dead zone and throw.
   */
  let cameraOnAt = null;
  let camWarned = false;

  const net = connect(roomCode);

  // ── state that has to survive from the very first message ──
  //
  // Everything below this line is wired SYNCHRONOUSLY, before any await. A peer
  // can connect while we are still on the status card, and a handler assigned
  // after an await misses their meta entirely — no name, no roster, no room state.
  // This rule has broken this app twice; see PROJECT.md.

  const pendingStreams = [];
  const peerAv = new Map();          // peerId → their last {mic, cam}
  const greeted = new Set();
  /** peerId → the phase they last reported. Read by hostId at decision time. */
  const phaseByPeer = new Map();
  /** People waiting at the door, oldest first: [{id, name}] */
  const knocking = [];

  const applyAv = id => { if (peerAv.has(id)) call?.setPeerAv(id, peerAv.get(id)); };

  const shareAv = target => {
    if (!call?.live) return;
    net.sendAv({ mic: call.micOn, cam: call.camOn }, target);
  };

  const listNames = names =>
    names.length <= 1 ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  /** Our identity card, sent to the whole room or to one newcomer. */
  const myMeta = () => ({
    name: myName,
    joinedAt: net.joinedAt,     // decides who hosts — earliest joiner wins
    fingerprint: movieFp,
    fileName: movieFile.name,
    duration: video.duration,
  });

  /** What the host publishes about the room. */
  const myPhase = () => ({ phase, policy: { ...policy } });

  net.onPeerJoin = id => {
    // Introduce ourselves directly to the newcomer. A broadcast would reach them
    // too, but targeting means a late arrival always learns about everyone already
    // here, which is what makes the roster correct rather than order-dependent.
    //
    // Not while we are still knocking, though: someone waiting at the door is not
    // in the room, and sending meta would put them in everyone's roster and make
    // them eligible to be elected host.
    if (admitted) net.sendMeta(myMeta(), id);

    // Tell them what they have walked into. Only the host's answer counts, but
    // everyone replies — the newcomer decides whose to believe once it knows who
    // the host is, which removes an ordering problem we cannot otherwise control.
    if (admitted) net.sendPhase(myPhase(), id);

    // Send them our camera. This is REQUIRED, not a retry: room.addStream() only
    // reaches peers already in the room, so a peer who arrives after our camera
    // came up would otherwise never receive it. Verified: without this line
    // nobody receives anybody's video.
    if (call?.stream) net.addStream(call.stream, id);

    // And tell them whether that camera and mic are currently muted, so their
    // copy of our tile starts out correct rather than assuming "both on".
    shareAv(id);

    sync?.forceResync();
  };

  net.onPeerLeave = id => {
    const who = net.name(id);
    peerAv.delete(id);
    phaseByPeer.delete(id);
    call?.detachPeer(id);

    // If the person at the door gave up, take them off it.
    const waiting = knocking.findIndex(k => k.id === id);
    if (waiting >= 0) { knocking.splice(waiting, 1); renderKnock(); }

    if (admitted) chat?.system(`${who} left.`);
    renderRoster();
  };

  net.onMeta = ({ name, fingerprint: theirFp, fileName }, from) => {
    call?.setPeerName(from, name || 'Someone');

    // Meta can arrive more than once per person (we re-send on every join so the
    // roster stays complete), so only announce them the first time.
    if (!greeted.has(from)) {
      greeted.add(from);
      if (admitted) chat?.system(`${name || 'Someone'} joined.`);
    }

    if (theirFp && movieFp && theirFp !== movieFp) {
      banner(banners, {
        id: `mismatch:${from}`, kind: 'warn', sticky: true,
        title: `${name || 'Someone'} has a different file`,
        body: `Yours: ${movieFile.name} · Theirs: ${fileName}. Timestamps may not line up — `
            + 'they can use the sync offset in Settings to correct it.',
      });
    }
  };

  net.onAv = (state, from) => {
    peerAv.set(from, state);
    applyAv(from);
  };

  // Streams can arrive before the call object exists; hold them until it does.
  net.onStream = (stream, from) => {
    if (!call) { pendingStreams.push([from, stream]); return; }
    attachStream(from, stream);
  };

  function attachStream(from, stream) {
    call.attachPeer(from, stream);
    // Label it immediately. The tile is only created here, so a `meta` that
    // arrived FIRST set the name on a tile that did not exist yet and was lost —
    // which is exactly how every tile ended up blank. Mute state has the same
    // ordering problem, hence the replay.
    call.setPeerName(from, net.name(from));
    applyAv(from);
  }

  net.onPhase = (state, from) => {
    phaseByPeer.set(from, state);

    // Only the host runs the room. Accepting this from anyone would let a stale
    // window start the movie for everybody.
    if (from !== net.hostId || net.isHost) return;

    Object.assign(policy, state.policy || {});
    applyPolicy();
    if (state.phase === 'playing' && phase === 'lobby') enterPlaying({ announce: true });
  };

  net.onRoster = () => renderRoster();

  // ── the door ──

  net.onKnock = ({ name }, from) => {
    if (!net.isHost || phase !== 'playing') return;

    if (!policy.allowLate) {
      // Answered without ever interrupting the host. That is the point of the
      // toggle: "no" should cost the host nothing.
      net.sendVerdict({ allowed: false, reason: 'closed' }, from);
      return;
    }

    if (!knocking.some(k => k.id === from)) knocking.push({ id: from, name: name || 'Someone' });
    renderKnock();
  };

  net.onVerdict = ({ allowed, reason }, from) => {
    if (admitted || from !== net.hostId) return;
    if (allowed) return admit({ startPhase: 'playing' });

    showConnStatus({
      title: reason === 'closed' ? 'This room is closed' : 'Not right now',
      body: reason === 'closed'
        ? `${net.name(from)} has turned off joining after the movie starts.`
        : `${net.name(from)} declined the request.`,
      spinner: false,
      actions: { retry: knockAgain, back: abandon },
      retryLabel: 'Ask again',
    });
  };

  // ── gate: are we allowed in? ──

  if (mode === 'create') {
    // Creating a room means being the first one in it. There is nothing to check.
    await admit({ startPhase: 'lobby' });
  } else {
    await joinExisting();
  }

  /**
   * Join an existing room — which first means finding out whether it is one.
   *
   * There is no server and therefore no room registry: "this room exists" can
   * only ever mean "somebody is in it right now". So we join, and wait.
   */
  async function joinExisting() {
    showConnStatus({
      title: `Looking for room “${roomCode}”…`,
      body: 'Finding the other people in it. This usually takes a few seconds.',
      actions: { back: abandon },
    });
    $('statusRetry').hidden = true;

    const found = await waitFor(() => net.peerCount > 0, ROOM_PROBE_MS);

    if (!found) {
      return showConnStatus({
        title: `Room “${roomCode}” doesn't exist`,
        body: 'Nobody is in a room with that code. Check the code, or ask whoever '
            + 'invited you to open theirs first — a room only exists while someone is in it.',
        spinner: false,
        actions: { retry: () => joinExisting(), back: abandon },
      });
    }

    // Somebody is there. Now find out whether the film has already started —
    // specifically what the HOST says, which is why the answers are collected per
    // peer and read back by host id rather than taken first-come.
    showConnStatus({ title: 'Found it — joining…', body: '', actions: { back: abandon } });
    $('statusRetry').hidden = true;

    await waitFor(() => phaseByPeer.has(net.hostId), PHASE_WAIT_MS);
    const roomPhase = phaseByPeer.get(net.hostId);

    // No answer: assume the room is still gathering. Being let in when we should
    // have knocked is a far better failure than being stranded outside a room
    // that would have had us.
    if (!roomPhase || roomPhase.phase !== 'playing') {
      return admit({ startPhase: 'lobby' });
    }

    Object.assign(policy, roomPhase.policy || {});
    knockAgain();
  }

  /** Ask the host to let us in. */
  function knockAgain() {
    const host = net.hostId;
    net.sendKnock({ name: myName }, host);

    showConnStatus({
      title: 'The movie has already started',
      body: `Your request to join has been sent to ${net.name(host)}. `
          + 'You\'ll come straight in as soon as they say yes.',
      actions: { back: abandon },
    });
    $('statusRetry').hidden = true;

    // Keep waiting either way — the host may simply be watching the film. After a
    // while, offer the option of nudging them again.
    setTimeout(() => {
      if (admitted || $('statusCard').hidden) return;
      $('statusActions').hidden = false;
      $('statusRetry').hidden = false;
      $('statusRetry').textContent = 'Ask again';
      $('statusRetry').onclick = knockAgain;
    }, KNOCK_PATIENCE_MS);
  }

  /**
   * Give up and go back to the start.
   *
   * `net.leave()` is not optional. A window that stays in a room it abandoned is
   * precisely the ghost peer that cost this project an entire evening — the next
   * session connects to it, reports a healthy green "Connected", and is talking
   * to itself.
   */
  function abandon() {
    net.leave();
    showCard('landingCard');
  }

  /** Resolve when `test()` passes, or false on timeout. Polls; nothing to unwind. */
  function waitFor(test, ms) {
    return new Promise(resolve => {
      if (test()) return resolve(true);
      const started = Date.now();
      const timer = setInterval(() => {
        if (test()) { clearInterval(timer); resolve(true); }
        else if (Date.now() - started > ms) { clearInterval(timer); resolve(false); }
      }, 250);
    });
  }

  // ═══════════════════ inside the room ═══════════════════

  /**
   * We're in. Reveal the stage and build everything that needs a room to exist.
   *
   * Called either immediately (creating, or joining a room still in its waiting
   * phase) or much later, when the host approves a knock.
   */
  async function admit({ startPhase }) {
    admitted = true;
    phase = startPhase;

    $('lobby').hidden = true;
    // Set the phase class in the SAME synchronous tick as the reveal.
    // applyPhase() sets this same class ~70 lines further down, but several
    // `await`s land in between (attach, loadSubtitles, startCall) — and for
    // that whole window the stage would be visible with no phase class, so
    // the black, not-yet-started <video> paints over the ambient layer and
    // the waiting room is simply missing. Idempotent with applyPhase().
    stage.classList.toggle('phase-lobby', startPhase === 'lobby');
    if (startPhase === 'lobby') frames.mount(stage);
    else frames.stop();
    stage.hidden = false;

    attach(video, movieFile);
    if (subFile) await loadSubtitles(video, subFile);

    // ── sync ──
    sync = createSync(video, net, {
      onDrift: d => { $('diagDrift').textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)}s`; },
      onCorrection: (kind, d) => console.debug(`[sync] ${kind} correction, drift ${d.toFixed(2)}s`),
      onOffsetChange: v => { $('offsetVal').textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)}s`; },
      onStallChange: (us, waitingOn) => {
        centerStatus($('centerStatus'),
          us ? 'Buffering…'
            : waitingOn.length ? `Waiting for ${listNames(waitingOn)}…`
            : null);
      },
      onPlayBlocked: () => banner(banners, {
        id: 'autoplay', kind: 'warn', sticky: true,
        title: 'Click anywhere to allow playback',
        body: 'The browser blocked autoplay until you interact with the page.',
      }),
      // Safety net for a lost `phase` message: if the room starts playing around
      // us we join the film rather than sitting in a waiting room forever.
      onRemoteCtrl: msg => {
        if (phase === 'lobby' && msg.type === 'play') enterPlaying({ announce: true });
      },
    });

    // ── chat ──
    chat = createChat({
      panel: $('chatPanel'), log: $('chatLog'), form: $('chatForm'),
      input: $('chatInput'), badge: $('chatBadge'), bubbles: $('bubbles'),
      reactions: $('reactions'), picker: $('emojiPicker'),
      selfName: () => 'You',
    });
    chat.onSend = text => net.sendChat({ text, mediaTime: video.currentTime, sentAt: Date.now() });
    chat.onReact = emoji => net.sendReact({ emoji });

    net.onChat = ({ text, mediaTime }, from) =>
      chat.receive({ text, mediaTime, who: net.name(from) });
    net.onReact = ({ emoji }) => chat.receiveReaction(emoji);

    // Now that we are really in the room, tell everyone who we are. Peers who
    // arrived while we were knocking never got this.
    net.setSelf({ name: myName, fingerprint: movieFp, fileName: movieFile.name });
    net.sendMeta(myMeta());

    // ── call (no camera yet — see below) ──
    ({ call, duck } = await startCall({
      selfVideo: $('selfVideo'),
      selfTile: $('selfTile'),
      tiles: $('tiles'),
      onEnabled: stream => {
        // Both paths are required, and for different peers: the broadcast reaches
        // everyone already here, the targeted re-send in onPeerJoin reaches
        // everyone who arrives later.
        net.addStream(stream);
        shareAv();
        cameraOnAt = Date.now();
      },
    }));

    while (pendingStreams.length) {
      const [from, stream] = pendingStreams.shift();
      attachStream(from, stream);
    }

    wireStageUI();
    applyPhase();
    // Any policy we learned while still outside the room (from the host's `phase`
    // message during the probe) has had nowhere to land until sync existed.
    applyPolicy();
    renderRoster();

    // ── the camera ──
    //
    // Turned on automatically here, in the waiting room, and NOT at any point
    // during the film. Adding a media stream forces an ICE renegotiation on every
    // peer connection, which can kill a link that was working perfectly for data —
    // less likely now that a TURN relay is configured, but still possible on a bad
    // network pair. Doing it now means that if it is going to
    // break anything, it breaks while people are still saying hello — not ninety
    // minutes into the movie.
    if (sessionStorage.getItem('mw:noAutoCam') !== '1') {
      const stream = await call.enable();
      if (!stream) {
        banner(banners, {
          id: 'cam', kind: 'warn',
          title: 'Camera and mic unavailable',
          body: 'Everything else works — sync, chat and reactions are unaffected. '
              + 'Press the camera button to try again once you\'ve allowed access.',
        });
      }
    }
    refreshCamButtons();
  }

  // ── phase ──

  function applyPhase() {
    stage.classList.toggle('phase-lobby', phase === 'lobby');
    // The only correct place to retire the ambient stack. All four "the movie
    // starts now" paths funnel through here — host pressing start, a guest
    // receiving the phase message, the bare-play safety net in onRemoteCtrl,
    // and someone admitted mid-film who never calls enterPlaying() at all.
    // Hooking #startMovieBtn instead would miss three of them.
    if (phase !== 'lobby') frames.stop();
    $('greenRoom').hidden = phase !== 'lobby';
    $('greenCode').textContent = roomCode;
    updateControlAccess();
    renderRoster();
  }

  function enterPlaying({ announce = false } = {}) {
    if (phase === 'playing') return;
    phase = 'playing';
    applyPhase();
    if (announce) chat?.system('The movie has started.');
  }

  /** Host only: open the film for the whole room. */
  function startMovie() {
    // Phase first, so nobody is still looking at the waiting room when the movie
    // begins behind it.
    net.sendPhase({ phase: 'playing', policy: { ...policy } });
    enterPlaying();
    sync.startTogether();
  }

  /**
   * Playback controls are inert in the waiting room, and inert for everyone but
   * the host when the host has taken control.
   *
   * Disabled rather than hidden: a control that vanishes reads as a bug, one that
   * greys out reads as a rule.
   */
  function updateControlAccess() {
    const allowed = phase === 'playing' && sync?.canControl !== false;
    const why = phase === 'lobby'
      ? 'The movie hasn\'t started yet'
      : `Only ${net.name(net.hostId)} can control playback`;

    for (const id of ['playBtn', 'back10', 'fwd10', 'scrub']) {
      const el = $(id);
      // Stash the real tooltip the first time, or the explanation overwrites it
      // and the button never gets its own description back.
      el.dataset.title ??= el.title;
      el.disabled = !allowed;
      el.title = allowed ? el.dataset.title : why;
    }
  }

  function applyPolicy() {
    sync?.setControlLock(policy.control === 'host');
    $('allowLate').checked = policy.allowLate;
    $('controlPolicy').value = policy.control;
    updateControlAccess();
  }

  // ── the door, host side ──

  function renderKnock() {
    const next = knocking[0];
    $('joinRequest').hidden = !next;
    if (!next) return;

    $('jrName').textContent = next.name;          // textContent — remote input
    $('jrQueue').hidden = knocking.length < 2;
    $('jrQueue').textContent = knocking.length < 2 ? ''
      : `and ${knocking.length - 1} more waiting`;
  }

  function answerKnock(allowed) {
    const who = knocking.shift();
    if (!who) return;
    net.sendVerdict({ allowed }, who.id);
    if (allowed) {
      // They will send their own meta on arrival; this is just the host's own
      // confirmation that the button did something.
      chat?.system(`You let ${who.name} in.`);
      // Bring them to where we are as soon as they land.
      setTimeout(() => sync?.forceResync(), 1200);
    }
    renderKnock();
  }

  // ── roster ──

  /**
   * Draw the participant list, in both places it appears.
   *
   * This is the answer to "who is actually in here?" — the question that cost an
   * entire evening when every browser was confidently connected to a stale window
   * on its own machine. Showing names, host, and your own entry makes that failure
   * self-evident instead of invisible.
   */
  function renderRoster() {
    if (!admitted) return;

    const people = net.participants;

    for (const listId of ['rosterList', 'greenRoster']) {
      const list = $(listId);
      if (!list) continue;
      list.replaceChildren();

      for (const p of people) {
        const li = document.createElement('li');

        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.dataset.state = p.isSelf || p.known ? 'connected' : 'connecting';

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = p.name;                 // textContent — remote input

        li.append(dot, who);

        if (p.isHost) li.append(tag('host', 'HOST'));
        if (p.isSelf) li.append(tag('you', 'YOU'));
        // Flag anyone whose file differs from ours, so a sync problem has an
        // obvious explanation instead of looking like a bug.
        if (!p.isSelf && p.fingerprint && movieFp && p.fingerprint !== movieFp) {
          li.append(tag('mismatch', 'OTHER FILE'));
        }
        if (!p.isSelf && p.rttMs != null) {
          const ping = document.createElement('span');
          ping.className = 'ping';
          ping.textContent = `${Math.round(p.rttMs)} ms`;
          li.append(ping);
        }

        list.appendChild(li);
      }
    }

    // Re-label tiles from the roster as well. Names and streams arrive in either
    // order, so whichever lands second has to do the labelling.
    for (const p of people) if (!p.isSelf) call?.setPeerName(p.id, p.name);

    $('rosterCount').textContent = String(people.length);

    // Host-only controls. `isHost` is recomputed from join times on every call,
    // so these appear by themselves the moment the host leaves and the role
    // passes on — there is nothing to hand over.
    const host = net.isHost;
    $('hostControls').hidden = !host;
    $('startAllBtn').hidden = !host || phase !== 'playing';
    $('startMovieBtn').hidden = !host;

    $('rosterHint').textContent = host
      ? people.length > 1
        ? 'You are the host. Everyone jumps to your position when you press this.'
        : 'You are the host. Waiting for others to join.'
      : `${net.name(net.hostId)} is the host.`;

    $('greenWait').textContent = host
      ? people.length > 1
        ? 'Start whenever everyone looks ready.'
        : 'Share the link above, then start when everyone has arrived.'
      : `Waiting for ${net.name(net.hostId)} to start the movie…`;

    // A host who has taken control needs the policy reflected back; a follower who
    // has just been promoted needs the controls to match what they now own.
    if (host) {
      $('allowLate').checked = policy.allowLate;
      $('controlPolicy').value = policy.control;
    }
    updateControlAccess();
    updateStatusLine(people);
  }

  /**
   * A declaration, not a `const` arrow, on purpose: renderRoster() runs during
   * admit(), which is called near the top of this function, and a `const` down
   * here would still be in its temporal dead zone at that point. Every helper
   * reachable from admit() has to be hoisted.
   */
  function tag(kind, text) {
    const el = document.createElement('span');
    el.className = `tag ${kind}`;
    el.textContent = text;
    return el;
  }

  /** The one-line summary along the bottom of the control bar. */
  function updateStatusLine(people = net.participants) {
    const others = people.filter(p => !p.isSelf);
    $('connDot').dataset.state = others.length ? 'connected' : 'connecting';
    $('connText').textContent = others.length
      ? `${phase === 'lobby' ? 'In the waiting room' : 'Connected'} — with ${listNames(others.map(p => p.name))}`
      : 'Waiting for someone to join…';
  }

  // ── camera ──

  function refreshCamButtons() {
    $('camBtn').classList.toggle('off', call?.live ? !call.camOn : true);
    $('micBtn').classList.toggle('off', call?.live ? !call.micOn : true);
  }

  // ── everything that only makes sense once the stage is up ──

  function wireStageUI() {
    const scrub = $('scrub');
    let scrubbing = false;

    const showMeta = () => {
      $('timeTotal').textContent = formatTime(video.duration);
      $('diagFile').textContent = movieFile.name;
    };
    video.addEventListener('loadedmetadata', showMeta);
    // attach() runs before this listener is bound, so for a fast local file the
    // event has usually already fired. Catch up rather than waiting forever.
    if (video.readyState >= 1) showMeta();

    video.addEventListener('timeupdate', () => {
      if (scrubbing || !video.duration) return;
      scrub.value = String((video.currentTime / video.duration) * 1000);
      $('timeNow').textContent = formatTime(video.currentTime);
      // Feeds the hairline progress rail down the left edge of the stage
      // (#stage::after scales by this). Free — we already have the numbers.
      stage.style.setProperty('--progress', String(video.currentTime / video.duration));
    });

    // A class, NOT textContent. #playBtn holds two inline SVGs and writing
    // textContent here would delete both on the first play event.
    video.addEventListener('play',  () => $('playBtn').classList.add('playing'));
    video.addEventListener('pause', () => $('playBtn').classList.remove('playing'));

    scrub.addEventListener('pointerdown', () => (scrubbing = true));
    scrub.addEventListener('input', () => {
      $('timeNow').textContent = formatTime((scrub.value / 1000) * (video.duration || 0));
    });
    scrub.addEventListener('change', () => {
      scrubbing = false;
      sync.seekTo((scrub.value / 1000) * (video.duration || 0));
    });

    $('playBtn').addEventListener('click', () => sync.toggle());
    $('back10').addEventListener('click', () => sync.nudgeTime(-10));
    $('fwd10').addEventListener('click', () => sync.nudgeTime(10));

    // ── waiting room ──
    $('greenCopy').addEventListener('click', () => copyLink(roomCode, $('greenCopy')));
    $('startMovieBtn').addEventListener('click', () => {
      startMovie();
      banner(banners, { id: 'started', kind: 'info', body: 'Started for everyone in the room.' });
    });

    // ── the door ──
    $('jrAllow').addEventListener('click', () => answerKnock(true));
    $('jrDeny').addEventListener('click', () => answerKnock(false));

    // ── host controls ──
    $('allowLate').addEventListener('change', e => {
      policy.allowLate = e.target.checked;
      net.sendPhase(myPhase());
      banner(banners, {
        id: 'policy', kind: 'info',
        body: policy.allowLate
          ? 'People arriving after the start will ask to join.'
          : 'Nobody new can join once the movie has started.',
      });
    });

    $('controlPolicy').addEventListener('change', e => {
      policy.control = e.target.value;
      net.sendPhase(myPhase());
      applyPolicy();
      banner(banners, {
        id: 'policy', kind: 'info',
        body: policy.control === 'host'
          ? 'Only you can play, pause and seek now.'
          : 'Anyone can play, pause and seek.',
      });
    });

    // ── volume, mic, camera ──
    let userVolume = parseFloat(localStorage.getItem('mw:vol') ?? '1');
    video.volume = userVolume;
    $('volume').value = userVolume;

    // Auto-duck drives the movie volume via a multiplier, so the user's own volume
    // slider stays the source of truth.
    duck.onLevel = mult => { video.volume = Math.max(0, Math.min(1, userVolume * mult)); };

    const setVolume = v => {
      userVolume = Math.max(0, Math.min(1, v));
      $('volume').value = userVolume;
      localStorage.setItem('mw:vol', String(userVolume));
      video.volume = userVolume;
    };

    $('volume').addEventListener('input', e => setVolume(parseFloat(e.target.value)));
    $('voiceVolume').addEventListener('input', e => call.setPeerVolume(parseFloat(e.target.value)));

    $('micBtn').addEventListener('click', async () => {
      await call.toggleMic();
      refreshCamButtons();
      shareAv();
    });

    $('camBtn').addEventListener('click', async () => {
      await call.toggleCam();
      refreshCamButtons();
      shareAv();
      if (!call.live && call.error) {
        banner(banners, {
          id: 'cam', kind: 'warn',
          title: 'Camera and mic unavailable',
          body: 'The browser refused access. Check the permission prompt or the site '
              + 'settings, then press the camera button again.',
        });
      }
    });

    $('duckBtn').addEventListener('click', e => {
      const on = duck.toggle();
      e.currentTarget.classList.toggle('active', on);
      banner(banners, {
        id: 'duck', kind: 'info',
        body: on ? 'Movie will dip when they talk.' : 'Auto-duck off.',
      });
    });
    $('duckBtn').classList.toggle('active', duck.enabled);

    // ── subtitles, loadable at any moment ──
    //
    // With nothing loaded, CC goes straight to the file picker. It used to open
    // Settings and leave you to find the row, which is why people believed
    // subtitles had to be chosen up front — they never got that far.
    $('subsBtn').addEventListener('click', () => {
      if (!hasSubtitles(video)) return $('subFileLive').click();
      const on = toggleSubtitles(video);
      $('subsBtn').classList.toggle('off', !on);
    });

    $('subFileLive').addEventListener('change', async e => {
      const f = e.target.files[0];
      if (f) await useSubtitleFile(f);
    });

    // Dropping a file on the video is the other reflex, so support it too.
    stage.addEventListener('dragover', e => { e.preventDefault(); });
    stage.addEventListener('drop', async e => {
      const f = [...(e.dataTransfer?.files || [])]
        .find(x => /\.(srt|vtt)$/i.test(x.name));
      if (!f) return;
      e.preventDefault();
      await useSubtitleFile(f);
    });

    async function useSubtitleFile(f) {
      await loadSubtitles(video, f);
      applySubStyle();
      $('subsBtn').classList.remove('off');
      banner(banners, { id: 'subs', kind: 'info', body: `Subtitles loaded — ${f.name}. Only you see these.` });
    }

    const applySubStyle = () => styleSubtitles(video, {
      size: parseFloat($('subSize').value),
      bg: parseFloat($('subBg').value),
      pos: parseFloat($('subPos').value),
    });
    ['subSize', 'subBg', 'subPos'].forEach(id => $(id).addEventListener('input', applySubStyle));
    applySubStyle();

    // ── panels ──
    const openPanel = id => {
      const panel = $(id);
      const opening = panel.hidden;
      closeOtherPanels(PANELS, id);
      panel.hidden = !opening;
      return opening;
    };

    $('settingsBtn').addEventListener('click', () => openPanel('settingsPanel'));
    $('rosterBtn').addEventListener('click', () => {
      if (openPanel('rosterPanel')) renderRoster();
    });
    $('chatBtn').addEventListener('click', () => {
      closeOtherPanels(PANELS, 'chatPanel');
      chat.togglePanel();
    });
    $('reactBtn').addEventListener('click', () => {
      closeOtherPanels(PANELS, 'emojiPicker');
      chat.togglePicker();
    });

    $('startAllBtn').addEventListener('click', () => {
      sync.startTogether();
      banner(banners, { id: 'startall', kind: 'info', body: 'Brought everyone to your position.' });
      $('rosterPanel').hidden = true;
    });

    $('fsBtn').addEventListener('click', () => toggleFullscreen(stage));

    // ── settings panel ──
    document.querySelectorAll('[data-offset]').forEach(btn => {
      btn.addEventListener('click', () => {
        sync.setOffset(sync.offset + parseFloat(btn.dataset.offset));
      });
    });
    $('offsetVal').textContent = `${sync.offset >= 0 ? '+' : ''}${sync.offset.toFixed(1)}s`;

    $('resyncBtn').addEventListener('click', () => {
      sync.forceResync();
      banner(banners, { id: 'resync', kind: 'info', body: 'Resynced.' });
    });

    // ── video tile appearance ──
    // Both are written as custom properties on the stage, so one write covers your
    // own tile and everybody else's, including tiles that do not exist yet.
    const tileOpacity = $('tileOpacity');
    const tileSize = $('tileSize');

    tileOpacity.value = localStorage.getItem('mw:tileOpacity') ?? '1';
    tileSize.value = localStorage.getItem('mw:tileSize') ?? '200';

    const applyTileStyle = () => {
      stage.style.setProperty('--tile-opacity', tileOpacity.value);
      stage.style.setProperty('--tile-size', tileSize.value + 'px');
    };
    [tileOpacity, tileSize].forEach(el => el.addEventListener('input', () => {
      localStorage.setItem('mw:tileOpacity', tileOpacity.value);
      localStorage.setItem('mw:tileSize', tileSize.value);
      applyTileStyle();
    }));
    applyTileStyle();

    // ── diagnostics ──
    setInterval(async () => {
      $('diagRtt').textContent = net.rttMs != null ? `${net.rttMs} ms` : '—';
      $('diagRole').textContent = net.isHost ? 'host (reference)' : 'follower';
      $('diagPeers').textContent = String(net.peerCount);
      // Showing the names here is not cosmetic: seeing your OWN name in this row is
      // the fastest way to spot that you are connected to a stale local window.
      const others = net.participants.filter(p => !p.isSelf);
      $('diagPeerName').textContent = others.length
        ? `${others.map(p => p.name).join(', ')} (you are ${myName})`
        : '—';
      if (net.peerCount) {
        const s = sync.stalled;
        $('peerState').textContent = s.them.length ? `${listNames(s.them)} buffering`
          : phase === 'lobby' ? 'Waiting room'
          : video.paused ? 'Paused' : 'Playing together';
      }

      // Report the real RTCPeerConnection state rather than "we saw a peer join
      // once". A connection that fails during stream renegotiation used to leave
      // the dot green and the app silently dead.
      const d = await net.diagnose();
      $('diagConn').textContent = d.state;
      $('diagPath').textContent = d.candidate;

      // A host/host candidate pair means both ends reached each other over local
      // interface addresses — same machine, or same LAN. It cannot happen across
      // the internet. This is exactly how an evening got lost: both people were
      // connected to a leftover Movie Watch window on their OWN laptop, each
      // showing a confident green "Connected", while the two laptops had never
      // found each other at all.
      if (net.peerCount && d.candidate === 'host/host') {
        banner(banners, {
          id: 'localpeer', kind: 'warn', sticky: true,
          title: 'This connection is on your own machine',
          body: 'You are connected over a local-only network path. If the others are on '
              + 'different computers, this is a stale Movie Watch window on THIS one — '
              + 'check the room list; if you see your own name, close your other tabs '
              + 'and windows and reload. (Fine to ignore if you are all on the same wifi.)',
        });
      }

      const broken = d.state === 'failed' || d.state === 'disconnected';

      // Adding a camera renegotiates every peer connection, and that renegotiation
      // is still the single most likely thing to break a link that was working,
      // TURN or no TURN. If a failure shows up right after the camera went on, say so
      // and offer the way out, rather than leaving people to guess.
      if (net.peerCount && broken && !camWarned && cameraOnAt && Date.now() - cameraOnAt < 20_000) {
        camWarned = true;
        banner(banners, {
          id: 'cambroke', kind: 'err', sticky: true,
          title: 'The connection dropped just after the camera came on',
          body: 'Turning a camera on renegotiates the connection, and this network pair '
              + 'may not survive it without a TURN relay. Rejoining without video usually fixes it.',
          action: {
            label: 'Rejoin without video',
            onClick: () => {
              sessionStorage.setItem('mw:noAutoCam', '1');
              location.reload();
            },
          },
        });
      }

      if (net.peerCount && broken) {
        $('connDot').dataset.state = 'lost';
        $('connText').textContent = d.state === 'failed'
          ? 'Connection failed — no direct route between your networks'
          : 'Connection dropped — trying to recover…';
      } else if (net.peerCount && d.state === 'connected') {
        updateStatusLine();   // recovered, or never broke
      }
    }, 1000);

    // ── keyboard ──
    bindKeys({
      ' ':          () => sync.toggle(),
      ArrowLeft:    () => sync.nudgeTime(-5),
      ArrowRight:   () => sync.nudgeTime(5),
      ArrowUp:      () => setVolume(userVolume + 0.05),
      ArrowDown:    () => setVolume(userVolume - 0.05),
      f:            () => toggleFullscreen(stage),
      c:            () => $('subsBtn').click(),
      m:            () => $('micBtn').click(),
      t:            () => call.setTalking(true),
      Escape:       () => closeOtherPanels(PANELS, null),
    });
    bindKeyUp({ t: () => call.setTalking(false) });

    bindPanelCloses(stage);

    // Click the video (or a tile, or empty stage) to dismiss whatever panel is
    // open. The control bar is exempt — reaching for the volume slider with chat
    // open is still using the app, not dismissing the chat.
    bindDismissOnOutside(stage, PANELS, { exempt: [$('controls'), $('banners'), $('joinRequest')] });

    // Subtitles ride up out from under the control bar while it is on screen, and
    // drop back to the user's chosen height once it hides again.
    autoHideControls(stage, idle => setSubLift(video, !idle));

    banner(banners, {
      id: 'hello', kind: 'info',
      title: 'Headphones on?',
      body: 'Movie audio from speakers will echo into your mic and back to them.',
    });

    // `beforeunload` alone is not enough — it does not fire reliably when a tab is
    // discarded, backgrounded on mobile, or closed via the OS. A window that never
    // leaves lingers in the room as a "ghost" that the next session connects to
    // instead of the real person. `pagehide` covers the cases beforeunload misses.
    let departed = false;
    const depart = () => {
      if (departed) return;
      departed = true;
      sync?.destroy();
      call?.stop();
      net.leave();
    };
    window.addEventListener('beforeunload', depart);
    window.addEventListener('pagehide', depart);
  }
}
