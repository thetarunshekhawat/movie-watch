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

/**
 * `enabled: false` means the user deliberately chose to watch without cameras.
 * That is not an error state — we skip getUserMedia entirely, so there is no
 * permission prompt, no media track, and crucially no ICE renegotiation to send
 * one. Chat, reactions and playback sync then ride a data-only peer connection,
 * which is far more likely to survive between two networks with no TURN relay.
 */
export async function startCall({ selfVideo, selfTile, tiles, enabled = true }) {
  let stream = null;
  let error = null;

  if (enabled) {
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
  }

  placeSelfTile(selfTile);
  makeDraggable(selfTile, 'self');
  makeResizable(selfTile, 'self');

  /**
   * peerId → tile element. Built on demand rather than declared in the HTML,
   * because the room holds up to six people and we do not know who until they
   * arrive. Tiles stack down the right-hand edge in arrival order.
   */
  const peerTiles = new Map();

  function tileFor(peerId) {
    let tile = peerTiles.get(peerId);
    if (tile) return tile;

    tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.tile = 'peer';
    tile.innerHTML =
      '<video autoplay playsinline></video>' +
      '<span class="tile-label"></span>' +
      '<div class="tile-resize" data-resize="peer"></div>';
    tiles.appendChild(tile);
    peerTiles.set(peerId, tile);

    stackTile(tile, peerTiles.size - 1);
    // null key = do not persist. Peer ids are regenerated every session, so a
    // saved position could never be matched back to the same person anyway.
    makeDraggable(tile, null);
    makeResizable(tile, null);
    return tile;
  }

  const call = {
    stream,
    error,
    /** True when the user chose to watch without cameras — distinct from `error`. */
    off: !enabled,
    micOn: true,
    camOn: true,

    attachPeer(peerId, peerStream) {
      const tile = tileFor(peerId);
      tile.querySelector('video').srcObject = peerStream;
      tile.hidden = false;
      duck.watch(peerId, peerStream, tile);
    },

    detachPeer(peerId) {
      const tile = peerTiles.get(peerId);
      if (tile) {
        tile.querySelector('video').srcObject = null;
        tile.remove();
        peerTiles.delete(peerId);
      }
      duck.stop(peerId);
    },

    /** Label a tile once we know who it belongs to. */
    setPeerName(peerId, name) {
      const tile = peerTiles.get(peerId);
      if (tile) tile.querySelector('.tile-label').textContent = name;
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

    setPeerVolume(v) {
      peerTiles.forEach(t => (t.querySelector('video').volume = v));
    },

    stop() {
      duck.stopAll();
      stream?.getTracks().forEach(t => t.stop());
    },
  };

  const duck = createDucker();
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
function createDucker() {
  /**
   * One analyser per person, because in a group any of them talking should duck
   * the movie, and each needs its own speaking indicator on its own tile.
   * peerId → {analyser, source, data, tile, speaking, releaseTimer}
   */
  const watched = new Map();
  let ctx = null, raf = null;
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

    let anySpeaking = false;

    for (const w of watched.values()) {
      w.analyser.getByteTimeDomainData(w.data);
      let sum = 0;
      for (let i = 0; i < w.data.length; i++) {
        const v = (w.data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / w.data.length);

      if (rms > SPEAK_THRESHOLD) {
        if (!w.speaking) {
          w.speaking = true;
          w.tile?.classList.add('speaking');
        }
        clearTimeout(w.releaseTimer);
        w.releaseTimer = null;
      } else if (w.speaking && !w.releaseTimer) {
        w.releaseTimer = setTimeout(() => {
          w.speaking = false;
          w.releaseTimer = null;
          w.tile?.classList.remove('speaking');
        }, RELEASE_MS);
      }

      if (w.speaking) anySpeaking = true;
    }

    // Duck for as long as ANYONE is talking, and only lift when the room is quiet.
    target = anySpeaking && enabled ? DUCK_TO : 1;

    ramp();
  }

  return {
    get enabled() { return enabled; },

    set onLevel(fn) { onLevel = fn; },

    watch(peerId, stream, tile) {
      if (!stream.getAudioTracks().length) return;
      this.stop(peerId);

      // One shared AudioContext for the whole room — browsers cap how many you may
      // open, and six people would otherwise mean six contexts.
      ctx ||= new (window.AudioContext || window.webkitAudioContext)();

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Deliberately NOT connected to ctx.destination — the <video> element already
      // plays this audio, and connecting would double it.
      source.connect(analyser);

      watched.set(peerId, {
        source, analyser, tile,
        data: new Uint8Array(analyser.fftSize),
        speaking: false, releaseTimer: null,
      });

      if (!raf) loop();
    },

    toggle() {
      enabled = !enabled;
      localStorage.setItem(DUCK_KEY, enabled ? 'on' : 'off');
      if (!enabled) target = 1;
      return enabled;
    },

    /** Stop watching one person (they left, or their camera went away). */
    stop(peerId) {
      const w = watched.get(peerId);
      if (!w) return;
      clearTimeout(w.releaseTimer);
      w.source.disconnect();
      w.tile?.classList.remove('speaking');
      watched.delete(peerId);
      if (!watched.size) this.stopAll();
    },

    stopAll() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      watched.forEach(w => {
        clearTimeout(w.releaseTimer);
        w.source.disconnect();
        w.tile?.classList.remove('speaking');
      });
      watched.clear();
      ctx?.close().catch(() => {});
      ctx = null;
      target = current = 1;
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

/** Your own tile sits bottom-right of the stack, out of the way. */
function placeSelfTile(selfTile) {
  const s = { right: 18, top: 18, width: 150, ...savedTiles().self };
  if (s.left != null) { selfTile.style.left = s.left + 'px'; selfTile.style.right = 'auto'; }
  else { selfTile.style.right = (s.right ?? 18) + 'px'; }
  selfTile.style.top = (s.top ?? 18) + 'px';
  selfTile.style.width = (s.width ?? 150) + 'px';
}

/**
 * Default position for the Nth peer tile: stacked down the right edge, below your
 * own. Peer ids are regenerated every session, so saved positions cannot be keyed
 * to a person — stacking by arrival order is the only stable default. Drag one and
 * it stays put for the session.
 */
function stackTile(tile, index) {
  tile.style.right = '18px';
  tile.style.top = (150 + index * 170) + 'px';
  tile.style.width = '200px';
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
    if (key) saveTile(key, {
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
    if (key) saveTile(key, { width: parseFloat(tile.style.width) });
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
