/**
 * sync.js — playback state machine.
 *
 * The hard part of this project. Four mechanisms, all load-bearing:
 *
 *   1. ECHO SUPPRESSION. Applying a remote pause calls video.pause(), which fires a
 *      local 'pause' event, which broadcasts a pause back — an infinite loop. Every
 *      programmatic mutation is wrapped in `applyRemote()`, which raises a flag that
 *      local event handlers check before broadcasting. Nothing else here works until
 *      this is right.
 *
 *   2. COMMAND ORDERING. Both people hitting space at once produces two conflicting
 *      commands. A monotonic `seq` counter plus a peer-id tiebreak resolves it the
 *      same way on both machines, so they can't deadlock in a pause/play war.
 *
 *   3. DRIFT CORRECTION. Decoders drift apart even from a perfectly synced start.
 *      A 3s heartbeat drives a three-tier response: ignore / nudge playbackRate /
 *      hard seek. Everyone corrects toward the HOST (net.isHost) and the host never
 *      corrects, or the room chases several clocks at once and never settles.
 *
 *   4. STALL COORDINATION. If one side buffers, the other waits, then both resume.
 */

const HEARTBEAT_MS = 3000;

/** Drift below this is ignored. Prevents constant micro-corrections from jitter. */
const DEADBAND = 0.15;

/**
 * Above this we stop nudging and just seek.
 *
 * Deliberately not higher: a hard seek is a visible jump, but sitting 1.5s out of
 * sync is worse — dialogue is audibly offset between the two of you.
 */
const HARD_SEEK = 1.5;

/**
 * Nudging is proportional: we pick a playback rate that closes the gap in roughly
 * this many seconds, rather than a fixed delta.
 *
 * A fixed 3% delta (the first version of this) was far too gentle — closing 1.4s of
 * drift would have taken 47 seconds, during which the two sides are visibly apart.
 */
const CLOSE_IN_SEC = 4;

/** Rate delta bounds. Below MIN it's pointless; above MAX it's noticeable. */
const MIN_DELTA = 0.02;
const MAX_DELTA = 0.10;

/** Safety net: never leave playbackRate modified for longer than this. */
const MAX_NUDGE_MS = 10_000;

export function createSync(video, net, hooks = {}) {
  /** Raised while we are applying a remote command, to stop the echo. */
  let applyingRemote = false;

  /**
   * Lamport logical clock.
   *
   * This MUST advance on receive as well as on send. An earlier version kept a
   * private per-peer counter, which silently broke: after the peer sent commands
   * 1 and 2, our own counter was still 0, so our next command went out as seq 1 and
   * the peer rejected it as stale. Symptom was seeks that never propagated.
   * Taking max() on receive keeps both sides on a single shared ordering.
   */
  let clock = 0;
  let lastSeq = -1;
  let lastSeqPeer = '';

  /** Local-only correction for mismatched rips. Persisted per room. */
  const offsetKey = `mw:offset:${net.roomCode}`;
  let offset = parseFloat(localStorage.getItem(offsetKey) || '0') || 0;

  /**
   * Host-set policy: when true, only the host may drive playback.
   *
   * Enforced at BOTH ends deliberately. Blocking the send alone would be a
   * suggestion — anything that reached the wire would still be obeyed. Ignoring
   * non-host commands on receive is what makes it real, and it also covers the
   * window where someone has not yet been told the policy changed.
   */
  let controlLock = false;

  let nudgeTimer = null;
  let beatTimer = null;
  let weStalled = false;
  /**
   * Everyone currently buffering. A Set rather than a boolean because in a group
   * any one person stalling should hold the room, and we must not resume until the
   * LAST of them recovers.
   */
  const stalledPeers = new Set();
  let lastDrift = null;

  /**
   * Run a mutation without it echoing back to the peer.
   *
   * The flag is cleared on a timer rather than synchronously because media events
   * ('play', 'pause', 'seeked') fire asynchronously — clearing it immediately would
   * let the echo through. 60ms comfortably covers the event dispatch.
   */
  function applyRemote(fn) {
    applyingRemote = true;
    try { fn(); } finally {
      setTimeout(() => { applyingRemote = false; }, 60);
    }
  }

  /**
   * Should we accept an incoming command?
   *
   * Rejects anything older than what we've already applied. Equal sequence numbers
   * mean a genuine simultaneous press — broken by peer id so both machines pick the
   * same winner.
   */
  function accept(msg, fromPeer) {
    if (msg.seq > lastSeq) return true;
    if (msg.seq === lastSeq && fromPeer > lastSeqPeer) return true;
    return false;
  }

  function remember(msg, fromPeer) {
    lastSeq = msg.seq;
    lastSeqPeer = fromPeer;
    // Advance our clock past anything we've seen, so our next command sorts after it.
    clock = Math.max(clock, msg.seq);
  }

  /** Our current position in the shared timeline (our clock minus our local offset). */
  function sharedTime() {
    return video.currentTime - offset;
  }

  function broadcast(type) {
    if (!net.peerCount) return;
    if (controlLock && !net.isHost) return;
    clock += 1;
    const msg = { type, mediaTime: sharedTime(), seq: clock, sentAt: Date.now() };
    remember(msg, net.selfId);
    net.sendCtrl(msg);
  }

  function clearNudge() {
    if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
    if (video.playbackRate !== 1) video.playbackRate = 1;
  }

  // ─────────────────────────── local events → peer ───────────────────────────

  video.addEventListener('play', () => {
    if (applyingRemote) return;
    broadcast('play');
  });

  video.addEventListener('pause', () => {
    if (applyingRemote) return;
    clearNudge();
    broadcast('pause');
  });

  video.addEventListener('seeked', () => {
    if (applyingRemote) return;
    clearNudge();
    broadcast('seek');
  });

  // Buffering: tell the peer to hold. Rare with local files, but seeking triggers it.
  video.addEventListener('waiting', () => {
    if (applyingRemote || weStalled) return;
    weStalled = true;
    net.sendStall({ stalled: true });
    hooks.onStallChange?.(weStalled, stalledNames());
  });

  video.addEventListener('playing', () => {
    if (!weStalled) return;
    weStalled = false;
    net.sendStall({ stalled: false });
    hooks.onStallChange?.(weStalled, stalledNames());
  });

  const stalledNames = () => [...stalledPeers].map(id => net.name(id));

  // ─────────────────────────── peer → local ───────────────────────────

  net.onCtrl = (msg, fromPeer) => {
    // Must be the ACTUAL sender, not net.peerId. The tiebreak in accept() compares
    // peer ids, so crediting a message to the wrong peer can wrongly reject it.
    const from = fromPeer || net.peerId || '';
    // Host-only mode: a command from anyone else is dropped on the floor, so a
    // client that ignores the policy locally still cannot move the room.
    if (controlLock && from !== net.hostId) return;
    if (!accept(msg, from)) return;
    remember(msg, from);

    // Their timeline position, translated into ours.
    const target = msg.mediaTime + offset;

    if (msg.type === 'pause') {
      clearNudge();
      applyRemote(() => {
        video.pause();
        // Snap to their exact frame so we resume from the same place.
        if (Math.abs(video.currentTime - target) > DEADBAND) video.currentTime = target;
      });
    } else if (msg.type === 'play') {
      // Compensate for flight time: by the time this arrives they have already
      // advanced by roughly one one-way trip.
      const compensated = target + net.oneWay;
      applyRemote(() => {
        if (Math.abs(video.currentTime - compensated) > DEADBAND) video.currentTime = compensated;
        video.play().catch(err => hooks.onPlayBlocked?.(err));
      });
    } else if (msg.type === 'seek') {
      clearNudge();
      applyRemote(() => { video.currentTime = target; });
    }

    hooks.onRemoteCtrl?.(msg);
  };

  net.onStall = ({ stalled }, from) => {
    if (stalled) {
      stalledPeers.add(from);
      // Hold our position until they catch up.
      applyRemote(() => video.pause());
    } else {
      stalledPeers.delete(from);
      // Only resume once EVERYONE is ready — in a group, one person recovering
      // must not drag the room back into playing while another is still buffering.
      if (!weStalled && !stalledPeers.size && !video.ended) {
        applyRemote(() => video.play().catch(() => {}));
      }
    }
    hooks.onStallChange?.(weStalled, stalledNames());
  };

  /**
   * Heartbeat — the drift correction loop.
   *
   * Only the non-reference peer acts on it. The reference peer just reports its
   * position and never adjusts, which is what stops the two from chasing each other.
   */
  net.onBeat = (msg, from) => {
    if (!video.duration) return;

    // Only the HOST's position counts. With three or more people, correcting
    // toward whoever spoke last means chasing several different clocks at once and
    // never settling — everyone follows one reference or nobody converges.
    if (from !== net.hostId) return;

    // Where they are now, in our timeline, accounting for flight time.
    const theirNow = msg.mediaTime + offset + (msg.playing ? net.oneWay : 0);
    const drift = video.currentTime - theirNow;
    lastDrift = drift;
    hooks.onDrift?.(drift);

    if (net.isHost) return;             // we are the reference; never correct
    if (!msg.playing || video.paused) return;
    if (weStalled || stalledPeers.size) return;

    const mag = Math.abs(drift);

    if (mag < DEADBAND) {
      clearNudge();
      return;
    }

    if (mag >= HARD_SEEK) {
      clearNudge();
      applyRemote(() => { video.currentTime = theirNow; });
      hooks.onCorrection?.('seek', drift);
      return;
    }

    // Soft correction: run slightly fast or slow until the gap closes.
    // Rate delta is sized to close the gap in about CLOSE_IN_SEC seconds.
    const delta = Math.min(MAX_DELTA, Math.max(MIN_DELTA, mag / CLOSE_IN_SEC));
    const rate = drift > 0 ? 1 - delta : 1 + delta;

    // Time-stretch instead of pitch-shifting, so speeding up doesn't chipmunk the
    // dialogue. This is Chrome's default but worth pinning down explicitly.
    video.preservesPitch = true;

    if (Math.abs(video.playbackRate - rate) > 0.001) {
      video.playbackRate = rate;
      hooks.onCorrection?.('nudge', drift);
    }
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(clearNudge, Math.min((mag / delta) * 1000, MAX_NUDGE_MS));
  };

  beatTimer = setInterval(() => {
    if (!net.peerCount || !video.duration) return;
    net.sendBeat({
      mediaTime: sharedTime(),
      playing: !video.paused && !video.ended,
      sentAt: Date.now(),
    });
  }, HEARTBEAT_MS);

  // ─────────────────────────── public API ───────────────────────────

  return {
    /**
     * May we drive playback right now?
     *
     * The local action has to be blocked as well as the broadcast. Letting a
     * locked-out person pause their own copy while the room plays on would leave
     * them silently out of sync — worse than the button simply not working.
     */
    get canControl() { return !controlLock || net.isHost; },

    /** Host policy: restrict play/pause/seek to the host. */
    setControlLock(on) { controlLock = !!on; },

    /** Toggle play/pause locally; the event listeners broadcast it. */
    toggle() {
      if (!this.canControl) return false;
      if (video.paused) video.play().catch(err => hooks.onPlayBlocked?.(err));
      else video.pause();
      return true;
    },

    /** Seek by a relative amount. Broadcast happens via the 'seeked' listener. */
    nudgeTime(delta) {
      if (!this.canControl) return false;
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + delta));
      return true;
    },

    seekTo(t) {
      if (!this.canControl) return false;
      video.currentTime = Math.max(0, Math.min(video.duration || 0, t));
      return true;
    },

    get offset() { return offset; },

    /** Adjust the local sync offset. Positive means "my copy runs ahead of theirs". */
    setOffset(v) {
      offset = Math.round(v * 10) / 10;
      localStorage.setItem(offsetKey, String(offset));
      hooks.onOffsetChange?.(offset);
    },

    /** Snap everyone to us immediately, ignoring the deadband. "Force resync". */
    forceResync() {
      if (!net.peerCount) return;
      clearNudge();
      broadcast(video.paused ? 'pause' : 'play');
    },

    /**
     * Host's "Start for everyone": pull the whole room to our position and play.
     *
     * Deliberately broadcasts even when we are already playing, so it doubles as a
     * "get everyone back together" button. The 'play' command already carries our
     * position and is latency-compensated on arrival, so no new message type is
     * needed — everyone seeks to where we will be and starts there.
     */
    startTogether() {
      clearNudge();
      if (video.paused) {
        video.play().catch(err => hooks.onPlayBlocked?.(err));   // 'play' event broadcasts
      } else {
        broadcast('play');
      }
    },

    get drift() { return lastDrift; },
    get stalled() { return { us: weStalled, them: stalledNames() }; },

    destroy() {
      clearInterval(beatTimer);
      clearNudge();
    },
  };
}
