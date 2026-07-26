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

/**
 * Watch key for our own stream.
 *
 * Our own voice is analysed exactly like everyone else's so that our own tile
 * gets the speaking outline — without it you can never tell whether your mic is
 * actually picking you up. It is flagged `selfOnly` so it does NOT duck the
 * movie: dipping the audio every time you speak would be maddening.
 */
const SELF = '__self__';

/** Voice level above which we consider them "speaking". Empirical. */
const SPEAK_THRESHOLD = 0.045;

/** Movie volume multiplier while they're talking. */
const DUCK_TO = 0.3;

/** How long they must be quiet before the movie comes back up. */
const RELEASE_MS = 500;

/**
 * Set up the call layer WITHOUT touching the camera.
 *
 * Acquiring the camera is deliberately a separate step (`call.enable()`), because
 * it is the one action here that changes the shape of every peer connection:
 * `room.addStream()` forces an ICE renegotiation, and with no TURN relay that can
 * kill a connection which was working perfectly for data. Keeping it separate
 * means the camera can be turned on at any moment in the session — nobody is
 * locked out of video by a checkbox they didn't tick — while a session that never
 * turns it on never pays that cost at all.
 *
 * `onEnabled(stream)` is how main.js learns it has a stream to send. It fires once
 * per successful acquisition, whenever that happens.
 */
export async function startCall({ selfVideo, selfTile, tiles, onEnabled = () => {} }) {
  let stream = null;
  let error = null;
  const duck = createDucker();

  placeTile(selfTile, 'self', { right: 18, top: 18 });
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
      '<span class="tile-badges"></span>' +
      '<div class="tile-resize" data-resize="peer"></div>';
    tiles.appendChild(tile);
    peerTiles.set(peerId, tile);

    // Peer ids are regenerated every session, so a saved position can never be
    // matched back to a person. Key by seat instead — arrival order — which at
    // least keeps a two-person room's layout stable across reloads.
    const index = peerTiles.size - 1;
    const key = `peer${index}`;
    placeTile(tile, key, { right: 18, top: 150 + index * 170 });
    makeDraggable(tile, key);
    makeResizable(tile, key);
    return tile;
  }

  const call = {
    /**
     * Getters, not fixed values: the camera can arrive at any point in the
     * session, so anything that captured `call.stream` once would still be
     * holding null long after the camera came up.
     */
    get stream() { return stream; },
    get error() { return error; },
    get live() { return stream != null; },

    micOn: true,
    camOn: true,

    /**
     * Acquire the camera and mic. Safe to call repeatedly — the second call is a
     * no-op, so button handlers don't have to guard.
     *
     * Returns the stream, or null if the user denied permission or has no device.
     * A denial is not fatal: the movie, sync and chat are unaffected, which is why
     * the failure is recorded rather than thrown.
     */
    async enable() {
      if (stream) return stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        error = err;
        return null;
      }

      error = null;
      selfVideo.srcObject = stream;
      selfTile.hidden = false;
      call.micOn = true;
      call.camOn = true;
      setTileAv(selfTile, { mic: true, cam: true });

      // Analyse our own mic so our own tile lights up while we talk. Excluded
      // from ducking (see SELF above) — dipping the movie whenever WE speak
      // would be maddening.
      duck.watch(SELF, stream, selfTile, { selfOnly: true });

      onEnabled(stream);
      return stream;
    },

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

    /**
     * Show someone's mic/camera state on their tile.
     *
     * A disabled remote track still arrives as a live-but-silent track, so there
     * is no reliable local way to tell "muted" from "quiet" — the peer has to
     * tell us, which is what the `av` message is for.
     */
    setPeerAv(peerId, state) {
      const tile = peerTiles.get(peerId);
      if (tile) setTileAv(tile, state);
    },

    /**
     * Mic and camera toggles.
     *
     * With no stream yet, the first press acquires one — that is what makes these
     * buttons a genuine on/off switch at any point in the movie rather than a
     * decision frozen in the lobby. Once a stream exists we only flip
     * `track.enabled`, which sends silence/a frozen frame down the existing
     * transceiver and triggers NO renegotiation.
     */
    async toggleMic() {
      if (!stream) return (await call.enable()) ? call.micOn : false;
      call.micOn = !call.micOn;
      stream.getAudioTracks().forEach(t => (t.enabled = call.micOn));
      setTileAv(selfTile, { mic: call.micOn, cam: call.camOn });
      return call.micOn;
    },

    async toggleCam() {
      if (!stream) return (await call.enable()) ? call.camOn : false;
      call.camOn = !call.camOn;
      stream.getVideoTracks().forEach(t => (t.enabled = call.camOn));
      setTileAv(selfTile, { mic: call.micOn, cam: call.camOn });
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

  return { call, duck };
}

/**
 * Render the mic/camera state onto a tile.
 *
 * The muted badge is deliberately understated — a small translucent 🔇 in the
 * corner. Camera-off reuses the existing `.cam-off` styling, which swaps the
 * frozen last frame for a placeholder.
 */
function setTileAv(tile, { mic = true, cam = true } = {}) {
  const badges = tile.querySelector('.tile-badges');
  if (badges) badges.textContent = mic ? '' : '🔇';
  tile.classList.toggle('cam-off', !cam);
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

      // Our own voice lights up our own tile but must never duck our own movie.
      if (w.speaking && !w.selfOnly) anySpeaking = true;
    }

    // Duck for as long as ANYONE is talking, and only lift when the room is quiet.
    target = anySpeaking && enabled ? DUCK_TO : 1;

    ramp();
  }

  return {
    get enabled() { return enabled; },

    set onLevel(fn) { onLevel = fn; },

    watch(peerId, stream, tile, { selfOnly = false } = {}) {
      if (!stream.getAudioTracks().length) return;
      this.stop(peerId);

      // One shared AudioContext for the whole room — browsers cap how many you may
      // open, and six people would otherwise mean six contexts.
      ctx ||= new (window.AudioContext || window.webkitAudioContext)();

      // Our own stream is watched the moment the camera is granted, which can be
      // before the user has clicked anything — an AudioContext created then starts
      // suspended and its analyser reads pure silence, so the speaking indicator
      // would never fire. Resume now, and again on the first real interaction.
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
        const kick = () => ctx?.resume().catch(() => {});
        window.addEventListener('pointerdown', kick, { once: true });
        window.addEventListener('keydown', kick, { once: true });
      }

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Deliberately NOT connected to ctx.destination — the <video> element already
      // plays this audio, and connecting would double it.
      source.connect(analyser);

      watched.set(peerId, {
        source, analyser, tile, selfOnly,
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

/**
 * Position a tile: saved placement if we have one, otherwise the given default.
 *
 * Width is written as the `--tile-w` custom property rather than `width`, so a
 * hand-resized tile keeps its own size while every untouched tile follows the
 * global tile-size slider (see `--tile-size` in style.css).
 */
function placeTile(tile, key, fallback) {
  const s = { ...fallback, ...(key ? savedTiles()[key] : null) };
  if (s.left != null) {
    tile.style.left = s.left + 'px';
    tile.style.right = 'auto';
  } else {
    tile.style.left = 'auto';
    tile.style.right = (s.right ?? 18) + 'px';
  }
  tile.style.top = (s.top ?? 18) + 'px';
  if (s.width != null) tile.style.setProperty('--tile-w', s.width + 'px');
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
    // Clamp against the OFFSET parent — the box these absolute coordinates are
    // actually relative to — not `parentElement`. Peer tiles live in a wrapper
    // div; before it was made a full-stage layer that div had zero height, so
    // `clamp(top, 0, 0 - h)` collapsed to 0 and every peer tile was pinned to the
    // top edge, movable sideways only. Using offsetParent makes the two tile
    // kinds behave identically no matter how they are nested.
    const parent = (tile.offsetParent || tile.parentElement).getBoundingClientRect();
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
    // Per-tile override of the global size slider.
    tile.style.setProperty('--tile-w', clamp(startW + (e.clientX - startX), 110, 460) + 'px');
  });

  const end = e => {
    if (!resizing) return;
    resizing = false;
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    if (key) saveTile(key, { width: parseFloat(tile.style.getPropertyValue('--tile-w')) });
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
