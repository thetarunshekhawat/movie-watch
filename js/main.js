/**
 * main.js — bootstrap and wiring.
 *
 * Owns the lobby → player transition and connects every module to the others.
 * Deliberately holds no sync logic of its own; that all lives in sync.js.
 */

import { connect, selfId } from './net.js';
import { createSync } from './sync.js';
import { preflight, fingerprint, attach, remuxCommand, formatTime } from './player.js';
import { loadSubtitles, toggleSubtitles, styleSubtitles, hasSubtitles } from './subs.js';
import { startCall } from './call.js';
import { createChat } from './chat.js';
import {
  autoHideControls, toggleFullscreen, bindKeys, bindKeyUp, banner,
  centerStatus, bindPanelCloses,
} from './ui.js';

const $ = id => document.getElementById(id);

// ─────────────────────────── lobby ───────────────────────────

const lobby = {
  name: $('displayName'),
  room: $('roomCode'),
  copy: $('copyLink'),
  shareHint: $('shareHint'),
  video: $('videoFile'),
  videoStatus: $('videoStatus'),
  sub: $('subFile'),
  subStatus: $('subStatus'),
  camera: $('useCamera'),
  join: $('joinBtn'),
  error: $('lobbyError'),
};

let movieFile = null;
let movieFp = null;
let subFile = null;

// Prefill from the URL and from last time.
const params = new URLSearchParams(location.search);
lobby.room.value = params.get('room') || localStorage.getItem('mw:room') || randomRoom();
lobby.name.value = localStorage.getItem('mw:name') || '';
lobby.camera.checked = localStorage.getItem('mw:camera') === 'on';
updateShareHint();

lobby.room.addEventListener('input', updateShareHint);

function updateShareHint() {
  const code = lobby.room.value.trim();
  if (!code) { lobby.shareHint.textContent = ''; return; }
  lobby.shareHint.textContent = `Share: ${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

lobby.copy.addEventListener('click', async () => {
  const code = lobby.room.value.trim();
  if (!code) return;
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
  try {
    await navigator.clipboard.writeText(url);
    lobby.copy.textContent = 'Copied ✓';
    setTimeout(() => (lobby.copy.textContent = 'Copy link'), 1600);
  } catch {
    lobby.shareHint.textContent = url;
  }
});

lobby.video.addEventListener('change', async () => {
  const file = lobby.video.files[0];
  if (!file) return;

  movieFile = null;
  movieFp = null;
  lobby.join.disabled = true;
  setStatus(lobby.videoStatus, '', 'Checking whether the browser can play this…');

  const result = await preflight(file);

  if (!result.ok) {
    setStatus(
      lobby.videoStatus, 'err',
      `${result.reason}\n\nConvert it first — this is fast and lossless:`,
      result.fix || remuxCommand(file.name)
    );
    return;
  }

  movieFile = file;
  setStatus(lobby.videoStatus, '', 'Fingerprinting…');
  movieFp = await fingerprint(file);

  const summary = `✓ ${file.name} — ${formatTime(result.duration)}, ${(file.size / 1e9).toFixed(2)} GB`;

  if (result.audioWarning) {
    // Playable, but probably silent. Let them continue — they may know it's silent.
    setStatus(
      lobby.videoStatus, 'warn',
      `${summary}\n\n⚠ ${result.audioWarning.reason}\n\nTo fix the audio:`,
      result.audioWarning.fix
    );
  } else {
    setStatus(lobby.videoStatus, 'ok', summary);
  }

  lobby.join.disabled = false;
});

lobby.sub.addEventListener('change', () => {
  subFile = lobby.sub.files[0] || null;
  if (subFile) setStatus(lobby.subStatus, 'ok', `✓ ${subFile.name} — only you will see these`);
});

function setStatus(el, cls, text, code) {
  el.className = 'file-status' + (cls ? ' ' + cls : '');
  el.textContent = text;
  if (code) {
    const c = document.createElement('code');
    c.textContent = code;
    el.appendChild(c);
  }
}

lobby.join.addEventListener('click', () => {
  const room = lobby.room.value.trim();
  if (!room) return showLobbyError('Pick a room code — you both need the same one.');
  if (!movieFile) return showLobbyError('Choose a movie file first.');

  localStorage.setItem('mw:room', room);
  localStorage.setItem('mw:name', lobby.name.value.trim());
  localStorage.setItem('mw:camera', lobby.camera.checked ? 'on' : 'off');

  history.replaceState(null, '', `?room=${encodeURIComponent(room)}`);
  start(room).catch(err => showLobbyError(err.message || String(err)));
});

function showLobbyError(msg) {
  lobby.error.textContent = msg;
  lobby.error.hidden = false;
}

function randomRoom() {
  return 'movie-' + Math.random().toString(36).slice(2, 8);
}

// ─────────────────────────── player ───────────────────────────

async function start(roomCode) {
  const stage = $('stage');
  const video = $('movie');
  const banners = $('banners');

  $('lobby').hidden = true;
  stage.hidden = false;

  const myName = lobby.name.value.trim() || 'Guest';

  attach(video, movieFile);
  if (subFile) await loadSubtitles(video, subFile);

  // ── network ──
  const net = connect(roomCode);
  const sync = createSync(video, net, {
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
  });

  // ── chat ──
  // Created before the call, because it's synchronous and the peer may start
  // talking the moment they connect.
  const chat = createChat({
    panel: $('chatPanel'), log: $('chatLog'), form: $('chatForm'),
    input: $('chatInput'), badge: $('chatBadge'), bubbles: $('bubbles'),
    reactions: $('reactions'), picker: $('emojiPicker'),
    selfName: () => 'You',
  });

  chat.onSend = text => net.sendChat({ text, mediaTime: video.currentTime, sentAt: Date.now() });
  chat.onReact = emoji => net.sendReact({ emoji });

  // ── peer lifecycle ──
  //
  // Every net handler MUST be wired synchronously, before the first await below.
  // getUserMedia shows a permission prompt that a real user can sit on for many
  // seconds, and the peer can connect during that window. An earlier version
  // assigned these after `await startCall(...)`, so a peer who joined during the
  // prompt hit the default no-op handlers: no meta exchange, no name, no file
  // mismatch warning, and no initial resync. It only showed up in testing because
  // headless Chrome rejects getUserMedia instantly.
  let call = null;
  let duck = null;
  const pendingStreams = [];

  const listNames = names =>
    names.length <= 1 ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  /**
   * Draw the participant list.
   *
   * This is the answer to "who is actually in here?" — the question that cost an
   * entire evening when every browser was confidently connected to a stale window
   * on its own machine. Showing names, host, and your own entry makes that failure
   * self-evident instead of invisible.
   */
  function renderRoster() {
    const people = net.participants;
    const list = $('rosterList');
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

    // Re-label tiles from the roster as well. Names and streams arrive in either
    // order, so whichever lands second has to do the labelling.
    for (const p of people) if (!p.isSelf) call?.setPeerName(p.id, p.name);

    $('rosterCount').textContent = String(people.length);
    $('startAllBtn').hidden = !net.isHost;
    $('rosterHint').textContent = net.isHost
      ? people.length > 1
        ? 'You are the host. Everyone jumps to your position when you press this.'
        : 'You are the host. Waiting for others to join.'
      : `${net.name(net.hostId)} is the host. Anyone can pause or seek.`;

    updateStatusLine(people);
  }

  const tag = (kind, text) => {
    const el = document.createElement('span');
    el.className = `tag ${kind}`;
    el.textContent = text;
    return el;
  };

  /** The one-line summary along the bottom of the control bar. */
  function updateStatusLine(people = net.participants) {
    const others = people.filter(p => !p.isSelf);
    $('connDot').dataset.state = others.length ? 'connected' : 'connecting';
    $('connText').textContent = others.length
      ? `Connected — watching with ${listNames(others.map(p => p.name))}`
      : 'Waiting for someone to join…';
  }

  net.setSelf({ name: myName, fingerprint: movieFp, fileName: movieFile.name });

  net.onChat = ({ text, mediaTime }, from) =>
    chat.receive({ text, mediaTime, who: net.name(from) });
  net.onReact = ({ emoji }) => chat.receiveReaction(emoji);

  /** Our identity card, sent to the whole room or to one newcomer. */
  const myMeta = () => ({
    name: myName,
    joinedAt: net.joinedAt,     // decides who hosts — earliest joiner wins
    fingerprint: movieFp,
    fileName: movieFile.name,
    duration: video.duration,
  });

  net.onPeerJoin = id => {
    // Introduce ourselves directly to the newcomer. A broadcast would reach them
    // too, but targeting means a late arrival always learns about everyone already
    // here, which is what makes the roster correct rather than order-dependent.
    net.sendMeta(myMeta(), id);

    // Send them our camera. This is REQUIRED, not a retry: room.addStream() only
    // reaches peers already in the room, and when we called it after the camera
    // prompt the room was still empty (peer discovery is slower than clicking
    // "Allow"). Without this line nobody ever receives anybody's video — verified,
    // every peer saw only themselves.
    if (call?.stream) net.addStream(call.stream, id);

    // Bring them to our current position immediately.
    sync.forceResync();
  };

  net.onPeerLeave = id => {
    const who = net.name(id);
    call?.detachPeer(id);
    chat.system(`${who} left.`);
    renderRoster();
  };

  // Streams can arrive before the local call object exists; hold them until then.
  net.onStream = (stream, from) => {
    if (!call) { pendingStreams.push([from, stream]); return; }
    call.attachPeer(from, stream);
    // Label it immediately. The tile is only created here, so a `meta` that
    // arrived FIRST set the name on a tile that did not exist yet and was lost —
    // which is exactly how every tile ended up blank.
    call.setPeerName(from, net.name(from));
  };

  // Wired here, before the await, for the reason documented at the top of this
  // block: peer meta arrives while the camera prompt is still open, and a handler
  // assigned after the await misses it entirely (no names, no roster, no
  // file-mismatch warning).
  const greeted = new Set();
  net.onMeta = ({ name, fingerprint: theirFp, fileName }, from) => {
    call?.setPeerName(from, name || 'Someone');

    // Meta can arrive more than once per person (we re-send on every join so the
    // roster stays complete), so only announce them the first time.
    if (!greeted.has(from)) {
      greeted.add(from);
      chat.system(`${name || 'Someone'} joined.`);
    }

    if (theirFp && movieFp && theirFp !== movieFp) {
      banner(banners, {
        id: `mismatch:${from}`, kind: 'warn', sticky: true,
        title: `${name || 'Someone'} has a different file`,
        body: `Yours: ${movieFile.name} · Theirs: ${fileName}. Timestamps may not line up — `
            + 'they can use the sync offset in Settings (⚙) to correct it.',
      });
    }
  };

  net.onRoster = () => renderRoster();

  // ── call (async — everything above must already be wired) ──
  const wantCamera = lobby.camera.checked;

  ({ call, duck } = await startCall({
    selfVideo: $('selfVideo'),
    selfTile: $('selfTile'),
    tiles: $('peerTiles'),
    enabled: wantCamera,
  }));

  if (call.off) {
    // Deliberate, so no warning — just hide the controls that would do nothing.
    document.querySelectorAll('[data-needs-camera]').forEach(el => (el.hidden = true));
  } else if (call.error) {
    banner(banners, {
      id: 'cam', kind: 'warn', sticky: true,
      title: 'Camera and mic unavailable',
      body: 'Sync and chat still work, but you won\'t see or hear each other. Check the browser permission prompt.',
    });
    document.querySelectorAll('[data-needs-camera]').forEach(el => (el.hidden = true));
  } else {
    // Covers the other ordering: a peer who was already here when the camera came
    // up. The targeted re-send in onPeerJoin covers peers who arrive after.
    net.addStream(call.stream);
  }

  while (pendingStreams.length) {
    const [from, stream] = pendingStreams.shift();
    call.attachPeer(from, stream);
    call.setPeerName(from, net.name(from));
  }

  renderRoster();

  // Auto-duck drives the movie volume via a multiplier, so the user's own volume
  // slider stays the source of truth.
  let userVolume = parseFloat(localStorage.getItem('mw:vol') ?? '1');
  video.volume = userVolume;
  $('volume').value = userVolume;
  duck.onLevel = mult => { video.volume = Math.max(0, Math.min(1, userVolume * mult)); };

  // ── control bar ──
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
  });

  video.addEventListener('play',  () => ($('playBtn').textContent = '⏸'));
  video.addEventListener('pause', () => ($('playBtn').textContent = '▶'));

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

  $('volume').addEventListener('input', e => {
    userVolume = parseFloat(e.target.value);
    localStorage.setItem('mw:vol', String(userVolume));
    video.volume = userVolume;
  });

  $('voiceVolume').addEventListener('input', e => call.setPeerVolume(parseFloat(e.target.value)));

  $('micBtn').addEventListener('click', e => {
    const on = call.toggleMic();
    e.currentTarget.classList.toggle('off', !on);
  });

  $('camBtn').addEventListener('click', e => {
    const on = call.toggleCam();
    e.currentTarget.classList.toggle('off', !on);
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

  $('subsBtn').addEventListener('click', () => {
    if (!hasSubtitles(video)) {
      $('settingsPanel').hidden = false;
      return;
    }
    const on = toggleSubtitles(video);
    $('subsBtn').classList.toggle('off', !on);
  });

  $('settingsBtn').addEventListener('click', () => {
    $('settingsPanel').hidden = !$('settingsPanel').hidden;
  });

  $('rosterBtn').addEventListener('click', () => {
    $('rosterPanel').hidden = !$('rosterPanel').hidden;
    if (!$('rosterPanel').hidden) renderRoster();
  });

  $('startAllBtn').addEventListener('click', () => {
    sync.startTogether();
    banner(banners, {
      id: 'startall', kind: 'info',
      body: 'Started for everyone in the room.',
    });
    $('rosterPanel').hidden = true;
  });

  $('chatBtn').addEventListener('click', () => chat.togglePanel());
  $('reactBtn').addEventListener('click', () => chat.togglePicker());
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

  $('subFileLive').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    await loadSubtitles(video, f);
    applySubStyle();
    $('subsBtn').classList.remove('off');
  });

  const applySubStyle = () => styleSubtitles(video, {
    size: parseFloat($('subSize').value),
    bg: parseFloat($('subBg').value),
    pos: parseFloat($('subPos').value),
  });
  ['subSize', 'subBg', 'subPos'].forEach(id =>
    $(id).addEventListener('input', applySubStyle)
  );
  applySubStyle();

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
            + 'check the roster (👥); if you see your own name, close your other tabs '
            + 'and windows and reload. (Fine to ignore if you are all on the same wifi.)',
      });
    }
    if (net.peerCount && (d.state === 'failed' || d.state === 'disconnected')) {
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
    Escape:       () => { $('chatPanel').hidden = true; $('settingsPanel').hidden = true; $('emojiPicker').hidden = true; },
  });
  bindKeyUp({ t: () => call.setTalking(false) });

  function setVolume(v) {
    userVolume = Math.max(0, Math.min(1, v));
    $('volume').value = userVolume;
    localStorage.setItem('mw:vol', String(userVolume));
    video.volume = userVolume;
  }

  bindPanelCloses(stage);
  autoHideControls(stage);

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
    sync.destroy();
    call.stop();
    net.leave();
  };
  window.addEventListener('beforeunload', depart);
  window.addEventListener('pagehide', depart);
}
