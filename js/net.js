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
 * DO NOT pin a hand-picked relay list here. This was tried and it broke discovery
 * outright — nobody could connect at all.
 *
 * The trap: "the WebSocket opens" is NOT the same as "this relay works". Trystero
 * signals over Nostr *ephemeral* events, and plenty of relays accept a connection
 * while silently declining to forward those — caching and aggregator services in
 * particular. Four of the six relays pinned in that attempt (primal, snort,
 * nostr.mom, offchain.pub) are absent from Trystero's own 47-relay default list
 * for exactly that reason, and with `redundancy: 4` a peer could draw four duds
 * and never be reachable.
 *
 * Trystero's defaults are curated against real Trystero traffic. The cert errors
 * a few of them throw (`schnorr.me`, `relay.agorist.space`) are console noise, not
 * a functional problem — the redundancy is there to absorb exactly that. Leave
 * relay selection alone unless you can test end-to-end peer discovery, from two
 * networks, against any replacement list.
 */


const PING_INTERVAL_MS = 10_000;
const RTT_SAMPLES = 7;

export { selfId };

/**
 * Join a room and return the transport.
 *
 * The room is a GROUP, not a pair. Up to about six people works comfortably;
 * Trystero builds a full mesh, so every extra person adds a connection to every
 * other person and the cost grows quadratically past that.
 */
export function connect(roomCode) {
  // Only pass turnConfig when we actually have relays, so the default-STUN-only
  // path stays exactly the documented default rather than "default plus empty list".
  const config = { appId: APP_ID };
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

  /**
   * When we joined, by our own wall clock.
   *
   * This decides who hosts (earliest joiner wins), so it is compared against other
   * machines' clocks, which are NOT synchronised. That is fine here and nowhere
   * else: people join a movie night minutes apart, and a few seconds of clock skew
   * cannot reorder that. Never use it for playback timing — see `oneWay`.
   */
  const joinedAt = Date.now();

  /**
   * Everyone in the room except us: peerId → participant record.
   *
   * A peer appears here on `onPeerJoin` with a placeholder name, and is filled in
   * when their `meta` arrives. Both steps matter — the roster should show that
   * *somebody* is here even before we know who.
   */
  const peers = new Map();

  /** Our own record, kept in the same shape so roster code has no special case. */
  let self = { id: selfId, name: 'You', joinedAt, fingerprint: null, fileName: null };

  /** Rolling RTT samples per peer, in ms. Median, to shrug off outliers. */
  const rtt = new Map();

  let pingTimer = null;

  const median = arr => {
    if (!arr?.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  /**
   * Who is the host?
   *
   * The earliest joiner, tie-broken by peer id so every machine computes the same
   * answer with no negotiation. Peers whose `meta` has not arrived yet are excluded
   * — we do not know when they joined, and guessing makes the host flap.
   *
   * The host is the reference for drift correction and the only one who can start
   * the movie for everybody. If they leave, the next-earliest person takes over
   * automatically, because this is recomputed rather than stored.
   */
  function computeHostId() {
    let best = self;
    for (const p of peers.values()) {
      if (p.joinedAt == null) continue;
      if (p.joinedAt < best.joinedAt ||
         (p.joinedAt === best.joinedAt && p.id < best.id)) best = p;
    }
    return best.id;
  }

  /** Fired whenever the roster changes shape or content, so the UI can redraw. */
  const notifyRoster = () => net.onRoster(net.participants);

  const net = {
    room,
    selfId,
    roomCode,
    joinedAt,

    /** Set our own identity, so we appear in our own roster correctly. */
    setSelf(patch) {
      self = { ...self, ...patch };
      notifyRoster();
    },

    /**
     * Everyone in the room including us, earliest joiner first.
     *
     * Sorted by join time so the list does not reshuffle as people come and go,
     * and so the host is always at the top.
     */
    get participants() {
      const hostId = computeHostId();
      const all = [self, ...peers.values()];
      return all
        .sort((a, b) => (a.joinedAt ?? Infinity) - (b.joinedAt ?? Infinity)
                     || (a.id < b.id ? -1 : 1))
        .map(p => ({
          id: p.id,
          name: p.name,
          fingerprint: p.fingerprint,
          fileName: p.fileName,
          isSelf: p.id === selfId,
          isHost: p.id === hostId,
          known: p.joinedAt != null,
          rttMs: p.id === selfId ? 0 : median(rtt.get(p.id)),
        }));
    },

    get hostId() { return computeHostId(); },
    get isHost() { return computeHostId() === selfId; },

    /** Peers only — excludes us. */
    get peerCount() { return peers.size; },
    get peerIds() { return [...peers.keys()]; },

    /** Kept for the diagnostics readout: the peer we most recently heard join. */
    get peerId() { return peers.size ? [...peers.keys()].pop() : null; },

    name(peerId) {
      if (peerId === selfId) return self.name;
      return peers.get(peerId)?.name || 'Someone';
    },

    /**
     * Estimated one-way latency to the HOST, in seconds.
     *
     * Sync compensation is always measured against the host, because that is whose
     * position everyone else is chasing. Starts at a conservative 50ms so the first
     * command is not wildly wrong before any probe has completed.
     */
    get oneWay() {
      const h = computeHostId();
      if (h === selfId) return 0;
      const m = median(rtt.get(h));
      return m == null ? 0.05 : m / 2 / 1000;
    },

    /**
     * Latency for the diagnostics panel, in ms.
     *
     * Followers report their round trip to the host, since that is the number that
     * actually governs their sync compensation. The host has no host to measure
     * against, so it reports the worst round trip in the room — the person most at
     * risk of drifting.
     */
    get rttMs() {
      const h = computeHostId();
      if (h !== selfId) {
        const m = median(rtt.get(h));
        return m == null ? null : Math.round(m);
      }
      const all = [...rtt.keys()].map(id => median(rtt.get(id))).filter(v => v != null);
      return all.length ? Math.round(Math.max(...all)) : null;
    },

    // ── senders ──
    sendCtrl:  d => ctrl.send(d),
    sendBeat:  d => beat.send(d),
    sendStall: d => stall.send(d),
    sendChat:  d => chat.send(d),
    sendReact: d => react.send(d),
    sendMeta:  (d, target) => meta.send(d, target ? { target } : undefined),

    // ── receivers, assigned by main.js. All get (data, senderPeerId). ──
    onCtrl:     () => {},
    onBeat:     () => {},
    onStall:    () => {},
    onChat:     () => {},
    onReact:    () => {},
    onMeta:     () => {},
    onPeerJoin: () => {},
    onPeerLeave:() => {},
    onStream:   () => {},
    onRoster:   () => {},

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
     * Live connection health for one peer, straight from the RTCPeerConnection.
     *
     * "Connected" on its own has already lied to us once, badly: every browser in
     * the room reported a healthy peer while actually talking to a stale window on
     * its own machine. `candidate` is the tell — 'host' on both ends means a
     * local-only network path, which cannot happen across the internet.
     * 'srflx'/'prflx' is a genuine direct connection, 'relay' means TURN.
     */
    async diagnose(peerId = computeHostId() === selfId ? net.peerId : computeHostId()) {
      const pc = peerId ? room.getPeers()[peerId] : null;
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
  // assuming it — with more than two people in the room there is no such thing as
  // "the peer", and guessing corrupts the sequence tiebreak in sync.js.
  ctrl.onMessage  = (d, { peerId: from }) => net.onCtrl(d, from);
  beat.onMessage  = (d, { peerId: from }) => net.onBeat(d, from);
  stall.onMessage = (d, { peerId: from }) => net.onStall(d, from);
  chat.onMessage  = (d, { peerId: from }) => net.onChat(d, from);
  react.onMessage = (d, { peerId: from }) => net.onReact(d, from);

  // Meta doubles as the roster feed: it is how we learn names and join times, and
  // therefore how the host is decided.
  meta.onMessage = (d, { peerId: from }) => {
    const existing = peers.get(from) || { id: from };
    peers.set(from, { ...existing, ...d, id: from });
    notifyRoster();
    net.onMeta(d, from);
  };

  room.onPeerJoin = id => {
    // Placeholder until their meta lands, so the roster can show that someone is
    // connecting rather than staying silent about them.
    if (!peers.has(id)) peers.set(id, { id, name: 'Joining…', joinedAt: null });
    rtt.delete(id);
    notifyRoster();
    net.onPeerJoin(id);
    probe(id);
  };

  room.onPeerLeave = id => {
    peers.delete(id);
    rtt.delete(id);
    notifyRoster();
    net.onPeerLeave(id);
  };

  room.onPeerStream = (stream, id) => net.onStream(stream, id);

  /** One RTT measurement. Failures are ignored — the peer may just have left. */
  async function probe(id) {
    if (!peers.has(id)) return;
    const t0 = performance.now();
    try {
      await ping.request(1, { target: id, timeoutMs: 4000 });
      const samples = rtt.get(id) || [];
      samples.push(performance.now() - t0);
      if (samples.length > RTT_SAMPLES) samples.shift();
      rtt.set(id, samples);
    } catch {
      /* timed out or peer gone; the next probe will retry */
    }
  }

  pingTimer = setInterval(() => net.peerIds.forEach(probe), PING_INTERVAL_MS);

  return net;
}
