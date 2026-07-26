/**
 * call.js — webcam/mic, the floating tiles, and auto-ducking.
 *
 * Auto-duck watches the incoming voice stream and lowers the MOVIE volume while
 * the other person is talking, so you stop missing dialogue every time someone
 * comments. It is a toggle (persisted) because it isn't always wanted.
 *
 * Note on echo: getUserMedia is asked for echoCancellation, but browser AEC is
 * tuned for voice and will not cancel loud continuous movie audio. Headphones are
 * a hard requirement and the UI says so. This is not fixable in code.
 */

const DUCK_KEY = 'mw:autoduck';
const TILE_KEY = 'mw:tiles';

/** Voice level above which we consider them "speaking". Empirical. */
const SPEAK_THRESHOLD = 0.045;

/** Movie volume multiplier while they're talking. */
const DUCK_TO = 0.3;

/** How long they must be quiet before the movie comes back up. */
const RELEASE_MS = 500;

export async function startCall({ selfVideo, peerVideo, selfTile, peerTile }) {
  let stream = null;
  let error = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    selfVideo.srcObject = stream;
    selfTile.hidden = false;
  } catch (err) {
    // Denied or no device. The movie half of the app still works fine.
    error = err;
  }

  restoreTilePositions(selfTile, peerTile);
  makeDraggable(selfTile, 'self');
  makeDraggable(peerTile, 'peer');
  makeResizable(selfTile, 'self');
  makeResizable(peerTile, 'peer');

  const call = {
    stream,
    error,
    micOn: true,
    camOn: true,

    attachPeer(peerStream) {
      peerVideo.srcObject = peerStream;
      peerTile.hidden = false;
      duck.watch(peerStream);
    },

    detachPeer() {
      peerVideo.srcObject = null;
      peerTile.hidden = true;
      duck.stop();
    },

    toggleMic() {
      if (!stream) return false;
      call.micOn = !call.micOn;
      stream.getAudioTracks().forEach(t => (t.enabled = call.micOn));
      return call.micOn;
    },

    toggleCam() {
      if (!stream) return false;
      call.camOn = !call.camOn;
      stream.getVideoTracks().forEach(t => (t.enabled = call.camOn));
      selfTile.classList.toggle('cam-off', !call.camOn);
      return call.camOn;
    },

    /** Push-to-talk: hold to un-mute, release to re-mute. */
    setTalking(on) {
      if (!stream || call.micOn) return;
      stream.getAudioTracks().forEach(t => (t.enabled = on));
    },

    setPeerVolume(v) { peerVideo.volume = v; },

    stop() {
      duck.stop();
      stream?.getTracks().forEach(t => t.stop());
    },
  };

  const duck = createDucker(peerTile);
  return { call, duck };
}

/**
 * Watches a stream's audio level and reports speaking state.
 *
 * Volume changes are ramped, not jumped — an abrupt cut sounds like a bug. We ramp
 * the <video>.volume property directly rather than routing the movie through
 * WebAudio, because piping a MediaElementSource would break the user's independent
 * volume slider and complicate muting.
 */
function createDucker(peerTile) {
  let ctx = null, analyser = null, source = null, raf = null;
  let data = null;
  let releaseTimer = null;
  let speaking = false;
  let enabled = localStorage.getItem(DUCK_KEY) !== 'off';

  /** Set by main.js — receives a multiplier in [DUCK_TO, 1]. */
  let onLevel = () => {};

  let current = 1;
  let target = 1;

  function ramp() {
    // Exponential approach: fast enough to catch the start of a sentence,
    // smooth enough not to sound like a pumping compressor.
    current += (target - current) * 0.18;
    if (Math.abs(current - target) < 0.005) current = target;
    onLevel(current);
  }

  function loop() {
    raf = requestAnimationFrame(loop);
    if (!analyser) return;

    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);

    if (rms > SPEAK_THRESHOLD) {
      if (!speaking) {
        speaking = true;
        peerTile.classList.add('speaking');
      }
      clearTimeout(releaseTimer);
      releaseTimer = null;
      target = enabled ? DUCK_TO : 1;
    } else if (speaking && !releaseTimer) {
      releaseTimer = setTimeout(() => {
        speaking = false;
        releaseTimer = null;
        peerTile.classList.remove('speaking');
        target = 1;
      }, RELEASE_MS);
    }

    ramp();
  }

  return {
    get enabled() { return enabled; },

    set onLevel(fn) { onLevel = fn; },

    watch(stream) {
      if (!stream.getAudioTracks().length) return;
      this.stop();
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Deliberately NOT connected to ctx.destination — the <video> element already
      // plays this audio, and connecting would double it.
      source.connect(analyser);
      data = new Uint8Array(analyser.fftSize);
      loop();
    },

    toggle() {
      enabled = !enabled;
      localStorage.setItem(DUCK_KEY, enabled ? 'on' : 'off');
      if (!enabled) target = 1;
      return enabled;
    },

    stop() {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(releaseTimer);
      raf = releaseTimer = null;
      source?.disconnect();
      ctx?.close().catch(() => {});
      ctx = analyser = source = null;
      speaking = false;
      target = current = 1;
      peerTile.classList.remove('speaking');
      onLevel(1);
    },
  };
}

// ───────────────────────── tile positioning ─────────────────────────

function savedTiles() {
  try { return JSON.parse(localStorage.getItem(TILE_KEY) || '{}'); }
  catch { return {}; }
}

function saveTile(key, patch) {
  const all = savedTiles();
  all[key] = { ...all[key], ...patch };
  localStorage.setItem(TILE_KEY, JSON.stringify(all));
}

function restoreTilePositions(selfTile, peerTile) {
  const all = savedTiles();
  const defaults = {
    peer: { right: 18, top: 18, width: 200 },
    self: { right: 18, top: 190, width: 150 },
  };
  for (const [key, tile] of [['self', selfTile], ['peer', peerTile]]) {
    const s = { ...defaults[key], ...all[key] };
    if (s.left != null) { tile.style.left = s.left + 'px'; tile.style.right = 'auto'; }
    else { tile.style.right = (s.right ?? 18) + 'px'; }
    tile.style.top = (s.top ?? 18) + 'px';
    tile.style.width = (s.width ?? defaults[key].width) + 'px';
  }
}

function makeDraggable(tile, key) {
  let startX, startY, originLeft, originTop, dragging = false;

  tile.addEventListener('pointerdown', e => {
    if (e.target.dataset.resize) return;   // resize handle owns this gesture
    dragging = true;
    tile.classList.add('dragging');
    tile.setPointerCapture(e.pointerId);
    const r = tile.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    originLeft = r.left; originTop = r.top;
    // Switch from right-anchored to left-anchored so dragging maths stays simple.
    tile.style.left = r.left + 'px';
    tile.style.right = 'auto';
  });

  tile.addEventListener('pointermove', e => {
    if (!dragging) return;
    const parent = tile.parentElement.getBoundingClientRect();
    const w = tile.offsetWidth, h = tile.offsetHeight;
    const left = clamp(originLeft + (e.clientX - startX) - parent.left, 0, parent.width - w);
    const top = clamp(originTop + (e.clientY - startY) - parent.top, 0, parent.height - h);
    tile.style.left = left + 'px';
    tile.style.top = top + 'px';
  });

  const end = e => {
    if (!dragging) return;
    dragging = false;
    tile.classList.remove('dragging');
    try { tile.releasePointerCapture(e.pointerId); } catch {}
    saveTile(key, {
      left: parseFloat(tile.style.left),
      top: parseFloat(tile.style.top),
      right: null,
    });
  };
  tile.addEventListener('pointerup', end);
  tile.addEventListener('pointercancel', end);
}

function makeResizable(tile, key) {
  const handle = tile.querySelector('.tile-resize');
  if (!handle) return;
  let startX, startW, resizing = false;

  handle.addEventListener('pointerdown', e => {
    e.stopPropagation();
    resizing = true;
    handle.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startW = tile.offsetWidth;
  });

  handle.addEventListener('pointermove', e => {
    if (!resizing) return;
    tile.style.width = clamp(startW + (e.clientX - startX), 110, 460) + 'px';
  });

  const end = e => {
    if (!resizing) return;
    resizing = false;
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    saveTile(key, { width: parseFloat(tile.style.width) });
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
