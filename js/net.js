/**
 * net.js — Trystero transport.
 *
 * Wraps Trystero so the rest of the app never touches WebRTC directly. Provides:
 *   • the six actions documented in PROJECT.md (ctrl / beat / stall / chat / react / meta)
 *   • a round-trip-time probe, since sync compensation needs a one-way latency estimate
 *   • peer lifecycle events
 *
 * There is deliberately NO signaling server. Trystero matchmakes over public Nostr
 * relays; once the peers are connected the relays are irrelevant and the session
 * survives if they go away. See the decision log in PROJECT.md.
 */

import { joinRoom, selfId } from 'https://esm.run/trystero';

/** Namespaces our rooms so we never collide with another Trystero app. */
const APP_ID = 'movie-watch-p2p-v1';

/**
 * TURN relay, used only when a direct peer-to-peer connection is impossible
 * (~10-15% of network pairs — symmetric NAT, CGNAT, most mobile hotspots and
 * corporate wifi). Media is relayed through it in that case, so it is slower —
 * but it beats not connecting at all.
 *
 * EMPTY ON PURPOSE. This used to point at openrelay.metered.ca with the public
 * `openrelayproject` credentials; that service is gone (see PROJECT.md gotchas).
 * There is no longer any credential-free public TURN server — they all get
 * abused as open proxies, so every survivor requires an account.
 *
 * Leaving a dead server in here is worse than leaving it empty: ICE gathering
 * waits on it before giving up, and it fills the console with noise.
 *
 * TO ENABLE: sign up for a free TURN provider and paste the credentials below.
 * Metered (metered.ca) gives 50GB/month free with no card and hands you exactly
 * this shape. Trystero's default STUN servers are still used either way.
 *
 *   const TURN = [{
 *     urls: ['turn:<your-subdomain>.metered.live:80',
 *            'turn:<your-subdomain>.metered.live:443?transport=tcp'],
 *     username: '<your-username>',
 *     credential: '<your-credential>',
 *   }];
 */
const TURN = [];

/**
 * Nostr relays, pinned rather than left to Trystero's defaults.
 *
 * Two peers only find each other if they share at least one working relay. The
 * default list contains several that fail outright from here — `schnorr.me`,
 * `relay.agorist.space` and `relay.nostr.bg` refuse the connection, and
 * `relay.nostr.band` times out — which both spams the console and, worse, eats
 * into the redundancy budget so the two sides can end up subscribed to disjoint
 * sets of working relays and never see each other.
 *
 * Every URL below was verified to accept a WebSocket connection. `redundancy`
 * is raised to 4 so a peer pair has to be very unlucky to share none.
 */
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://offchain.pub',
];

const PING_INTERVAL_MS = 10_000;
const RTT_SAMPLES = 7;

export { selfId };

export function connect(roomCode) {
  // Only pass turnConfig when we actually have relays, so the default-STUN-only
  // path stays exactly the documented default rather than "default plus empty list".
  const config = {
    appId: APP_ID,
    relayConfig: { urls: RELAYS, redundancy: 4 },
  };
  if (TURN.length) config.turnConfig = TURN;

  const room = joinRoom(config, roomCode);

  const ctrl  = room.makeAction('ctrl');
  const beat  = room.makeAction('beat');
  const stall = room.makeAction('stall');
  const chat  = room.makeAction('chat');
  const react = room.makeAction('react');
  const meta  = room.makeAction('meta');

  // Request-kind action: the peer echoes back whatever we send, letting us time it.
  const ping = room.makeAction('ping', {
    kind: 'request',
    onRequest: n => n,
  });

  /** Rolling RTT samples, in ms. We use the median to shrug off outliers. */
  const rttSamples = [];

  /**
   * The peer we are actually watching with.
   *
   * A room can contain more than two peers — a laptop with a forgotten second tab
   * open, or a session someone reloaded out of without the tab closing, lingers as
   * a "ghost" until its tab really goes away. This app is strictly two-person, so
   * we nominate the most recently joined peer as the real one and treat anything
   * else as a ghost. Ghost heartbeats are ignored (drift correction needs exactly
   * one source of truth) while their play/pause commands are still honoured.
   */
  let peerId = null;
  const allPeers = new Set();
  let pingTimer = null;

  const net = {
    room,
    selfId,
    roomCode,

    /** The connected peer's id, or null. */
    get peerId() { return peerId; },

    /** Every peer currently in the room, ghosts included. */
    get peerCount() { return allPeers.size; },

    /**
     * Estimated one-way latency in SECONDS.
     *
     * Starts at a conservative 50ms so the very first sync command is not wildly
     * wrong before any probe has completed.
     */
    get oneWay() {
      if (!rttSamples.length) return 0.05;
      const sorted = [...rttSamples].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] / 2 / 1000;
    },

    get rttMs() {
      if (!rttSamples.length) return null;
      const sorted = [...rttSamples].sort((a, b) => a - b);
      return Math.round(sorted[Math.floor(sorted.length / 2)]);
    },

    /**
     * Who is the drift-correction reference?
     *
     * Both peers must agree without negotiating, or they chase each other and
     * oscillate forever. Comparing peer id strings is deterministic and gives
     * opposite answers on the two machines, which is exactly what we need.
     * The peer with the SMALLER id is the reference; the other one corrects.
     */
    get isReference() {
      if (!peerId) return true;
      return selfId < peerId;
    },

    // ── senders ──
    sendCtrl:  d => ctrl.send(d),
    sendBeat:  d => beat.send(d),
    sendStall: d => stall.send(d),
    sendChat:  d => chat.send(d),
    sendReact: d => react.send(d),
    sendMeta:  d => meta.send(d),

    // ── receivers, assigned by main.js ──
    onCtrl:     () => {},
    onBeat:     () => {},
    onStall:    () => {},
    onChat:     () => {},
    onReact:    () => {},
    onMeta:     () => {},
    onPeerJoin: () => {},
    onPeerLeave:() => {},
    onStream:   () => {},

    /**
     * Send our camera/mic to peers.
     *
     * `target` matters more than it looks. `room.addStream(stream)` with no target
     * only reaches peers who are ALREADY in the room, and at the moment we call it
     * (right after the camera prompt) there is usually nobody there yet — Nostr peer
     * discovery takes several seconds longer than granting camera access does. The
     * result was that neither side ever sent its video. Trystero's own docs say to
     * re-send targeted on every peer join, which is what main.js now does.
     */
    addStream: (stream, target) =>
      room.addStream(stream, target ? { target } : undefined),

    /**
     * Live connection health, straight from the RTCPeerConnection.
     *
     * "Connected" on its own has already lied to us once: the data-channel handshake
     * succeeds over host/reflexive candidates, then adding a camera stream forces a
     * renegotiation that can fail on a network needing a TURN relay — leaving a dead
     * connection behind a green dot. `candidate` tells you which path is really in
     * use: 'host' = same machine, 'srflx'/'prflx' = direct across NAT, 'relay' = TURN.
     */
    async diagnose() {
      const pc = room.getPeers()[peerId];
      if (!pc) return { state: 'none', candidate: '—' };
      const out = { state: pc.connectionState || pc.iceConnectionState, candidate: '—' };
      try {
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach(r => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r;
        });
        if (pair) {
          const local = stats.get(pair.localCandidateId);
          const remote = stats.get(pair.remoteCandidateId);
          out.candidate = `${local?.candidateType ?? '?'}/${remote?.candidateType ?? '?'}`;
        }
      } catch { /* getStats is best-effort; never break the UI over diagnostics */ }
      return out;
    },

    leave() {
      clearInterval(pingTimer);
      room.leave();
    },
  };

  // Trystero delivers `(data, {peerId})`. Pass the sender id through rather than
  // assuming it — an earlier version credited every incoming message to `peerId`,
  // which is wrong the moment a ghost tab is also in the room, and quietly corrupts
  // the sequence-number tiebreak in sync.js.
  ctrl.onMessage  = (d, { peerId: from }) => net.onCtrl(d, from);
  stall.onMessage = (d, { peerId: from }) => net.onStall(d, from);
  chat.onMessage  = (d, { peerId: from }) => net.onChat(d, from);
  react.onMessage = (d, { peerId: from }) => net.onReact(d, from);
  meta.onMessage  = (d, { peerId: from }) => net.onMeta(d, from);

  // Drift correction needs exactly one reference position, so a ghost's heartbeat
  // must never reach it. Commands (ctrl) are not filtered — a play from any peer is
  // a real user pressing a real button.
  beat.onMessage = (d, { peerId: from }) => {
    if (from !== peerId) return;
    net.onBeat(d, from);
  };

  room.onPeerJoin = id => {
    allPeers.add(id);
    peerId = id;
    rttSamples.length = 0;   // latency to a new peer is unrelated to the old one
    net.onPeerJoin(id);
    probe();
  };

  room.onPeerLeave = id => {
    allPeers.delete(id);
    if (id === peerId) {
      // Fall back to another peer if one is still around, rather than going dark.
      peerId = [...allPeers].pop() ?? null;
      rttSamples.length = 0;
    }
    net.onPeerLeave(id);
  };

  room.onPeerStream = (stream, id) => net.onStream(stream, id);

  /** One RTT measurement. Failures are ignored — the peer may just have left. */
  async function probe() {
    if (!peerId) return;
    const t0 = performance.now();
    try {
      await ping.request(1, { target: peerId, timeoutMs: 4000 });
      rttSamples.push(performance.now() - t0);
      if (rttSamples.length > RTT_SAMPLES) rttSamples.shift();
    } catch {
      /* timed out or peer gone; the next probe will retry */
    }
  }

  pingTimer = setInterval(probe, PING_INTERVAL_MS);

  return net;
}
