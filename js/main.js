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

  const myName = lobby.name.value.trim() || 'Them';

  // Declared before createSync because the sync hooks close over it.
  let peerName = 'Them';

  attach(video, movieFile);
  if (subFile) await loadSubtitles(video, subFile);

  // ── network ──
  const net = connect(roomCode);
  const sync = createSync(video, net, {
    onDrift: d => { $('diagDrift').textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)}s`; },
    onCorrection: (kind, d) => console.debug(`[sync] ${kind} correction, drift ${d.toFixed(2)}s`),
    onOffsetChange: v => { $('offsetVal').textContent = `${v >= 0 ? '+' : ''}${v.toFixed(1)}s`; },
    onStallChange: (us, them) => {
      centerStatus($('centerStatus'),
        us ? 'Buffering…' : them ? `Waiting for ${peerName}…` : null);
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
  let pendingStream = null;

  net.onChat = ({ text, mediaTime }) => chat.receive({ text, mediaTime });
  net.onReact = ({ emoji }) => chat.receiveReaction(emoji);

  // With cameras off there is no tile to prove someone is there, so the status
  // line has to carry presence on its own.
  const showPresence = () => {
    $('connDot').dataset.state = 'connected';
    $('connText').textContent = net.peerId
      ? `Connected — watching with ${peerName}`
      : 'Waiting for them to join…';
  };

  net.onPeerJoin = id => {
    $('connDot').dataset.state = 'connected';
    showPresence();
    $('diagRole').textContent = net.isReference ? 'reference' : 'follower';
    net.sendMeta({
      name: myName,
      fingerprint: movieFp,
      fileName: movieFile.name,
      duration: video.duration,
    });

    // Send them our camera. This is REQUIRED, not a retry: room.addStream() only
    // reaches peers already in the room, and when we called it after the camera
    // prompt the room was still empty (peer discovery is slower than clicking
    // "Allow"). Without this line neither side ever receives the other's video —
    // verified, both peers saw only themselves.
    if (call?.stream) net.addStream(call.stream, id);

    // Bring them to our current position immediately.
    sync.forceResync();
  };

  net.onPeerLeave = () => {
    $('connDot').dataset.state = 'lost';
    $('connText').textContent = 'They disconnected — waiting for them to come back…';
    call?.detachPeer();
    chat.system(`${peerName} left.`);
  };

  // The stream can arrive before the local call object exists; hold it until then.
  net.onStream = stream => {
    if (call) call.attachPeer(stream);
    else pendingStream = stream;
  };

  // Wired here, before the await, for the reason documented at the top of this
  // block: the peer's meta arrives while the camera prompt is still open, and a
  // handler assigned after the await misses it entirely (no peer name, no
  // file-mismatch warning).
  net.onMeta = ({ name, fingerprint: theirFp, fileName }) => {
    peerName = name || 'Them';
    chat.peerName = peerName;
    $('peerLabel').textContent = peerName;
    showPresence();
    chat.system(`${peerName} joined.`);

    if (theirFp && movieFp && theirFp !== movieFp) {
      banner(banners, {
        id: 'mismatch', kind: 'warn', sticky: true,
        title: 'You two have different files',
        body: `Yours: ${movieFile.name} · Theirs: ${fileName}. Timestamps may not line up — `
            + 'use the sync offset in Settings (⚙) to correct it.',
      });
    }
  };

  // ── call (async — everything above must already be wired) ──
  const wantCamera = lobby.camera.checked;

  ({ call, duck } = await startCall({
    selfVideo: $('selfVideo'),
    peerVideo: $('peerVideo'),
    selfTile: $('selfTile'),
    peerTile: $('peerTile'),
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

  if (pendingStream) {
    call.attachPeer(pendingStream);
    pendingStream = null;
  }

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
    $('diagRole').textContent = net.peerId ? (net.isReference ? 'reference' : 'follower') : '—';
    $('diagPeers').textContent = String(net.peerCount);
    if (net.peerId) {
      const s = sync.stalled;
      $('peerState').textContent = s.them ? `${peerName} is buffering`
        : video.paused ? 'Paused' : 'Playing together';
    }

    // Report the real RTCPeerConnection state rather than "we saw a peer join
    // once". A connection that fails during stream renegotiation used to leave
    // the dot green and the app silently dead.
    const d = await net.diagnose();
    $('diagConn').textContent = d.state;
    $('diagPath').textContent = d.candidate;
    if (net.peerId && (d.state === 'failed' || d.state === 'disconnected')) {
      $('connDot').dataset.state = 'lost';
      $('connText').textContent = d.state === 'failed'
        ? 'Connection failed — no direct route between your two networks'
        : 'Connection dropped — trying to recover…';
    } else if (net.peerId && d.state === 'connected') {
      showPresence();   // recovered, or never broke
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

  window.addEventListener('beforeunload', () => {
    sync.destroy();
    call.stop();
    net.leave();
  });
}
