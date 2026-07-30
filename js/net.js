/**
 * net.js — Trystero transport.
 *
 * Wraps Trystero so the rest of the app never touches WebRTC directly. Provides:
 *   • the actions documented in PROJECT.md (ctrl / beat / stall / chat / react / meta / av)
 *   • a round-trip-time probe, since sync compensation needs a one-way latency estimate
 *   • peer lifecycle events
 *
 * There is deliberately NO signaling server. Trystero matchmakes over public Nostr
 * relays; once the peers are connected the relays are irrelevant and the session
 * survives if they go away. See the decision log in PROJECT.md.
 */

import { joinRoom, selfId, getRelaySockets } from 'https://esm.run/trystero';

/** Namespaces our rooms so we never collide with another Trystero app. */
const APP_ID = 'movie-watch-p2p-v1';

/**
 * TURN relay, used only when a direct peer-to-peer connection is impossible
 * (~10-15% of network pairs — symmetric NAT, CGNAT, most mobile hotspots and
 * corporate wifi). Media is relayed through it in that case, so it is slower —
 * but it beats not connecting at all.
 *
 * This was empty until 2026-07-27, and that emptiness was the bug. A real
 * cross-network pair could not connect: one side's network hands out a different
 * public IP per flow and filters on address+port, so neither side's connectivity
 * checks could ever land. The app reported that as *"Room doesn't exist"*. See
 * PROJECT.md → Known issues. An earlier openrelay.metered.ca entry with the
 * public `openrelayproject` credentials is long dead; there is no credential-free
 * public TURN server left, so this is a real account (Metered Open Relay, 20GB
 * free per month, project `movie-watch`).
 *
 * ALL FOUR URLS ARE LOAD-BEARING — do not trim this to the udp entry.
 * Gathering from the network that failed, the UDP lookups errored (`701 TURN host
 * lookup received error`) and only the TCP/TLS ones allocated. Ports 80 and 443
 * are chosen to pass firewalls that allow nothing else; `turns:` is TLS, which
 * survives deep-packet inspection. Verified from that same network: six `relay`
 * candidates allocated (via 45.79.127.179) with `iceTransportPolicy: 'relay'`.
 *
 * These credentials are PUBLIC — this is a static site with no backend, so anyone
 * who views source can read and spend them. Unavoidable without a server. Treat
 * the 20GB as burnable; rotate in the Metered dashboard if it drains. Re-fetch
 * with:
 *
 *   curl 'https://movie-watch.metered.live/api/v1/turn/credentials?apiKey=<KEY>'
 *
 * Trystero's default STUN servers are still used either way, and the stun: entry
 * that endpoint returns is therefore dropped here. TURN is only ever used when a
 * direct path is impossible, so pairs that can connect directly still do, and
 * pay nothing.
 */
const TURN = [{
  urls: [
    'turn:global.relay.metered.ca:80',
    'turn:global.relay.metered.ca:80?transport=tcp',
    'turn:global.relay.metered.ca:443',
    'turns:global.relay.metered.ca:443?transport=tcp',
  ],
  username: '63a472becbee94ec8e12b0f1',
  credential: 'kOX+q8Dd1KiZ+RMD',
}];

/**
 * How many Nostr relays to matchmake through.
 *
 * Trystero's default is 5, and that default was the second cause of *"Room doesn't
 * exist"* — the one that survived the TURN fix. Read `getRelays` in
 * `@trystero-p2p/core`:
 *
 *   relayConfig?.urls || shuffle(defaultRelayUrls, hash(appId)).slice(0, redundancy)
 *
 * The 47-relay default pool is shuffled by a hash of the APP ID — not the room code,
 * not per session — and then cut to 5. So every room this app has ever opened, for
 * everyone, forever, matchmakes through the same five relays:
 *
 *   social.amanah.eblessing.co · nostr.vulpem.com · schnorr.me
 *   testnet-relay.samt.st · relay-can.zombi.cloudrodion.com
 *
 * These are hobby relays. `schnorr.me` already fails in Chrome with
 * ERR_CERT_AUTHORITY_INVALID, so it is really four. Verified with two headless
 * Chrome instances (`tools/test-room.mjs`): blackhole those five at the DNS layer —
 * which is precisely what a blocking ISP or corporate firewall looks like to Chrome
 * — and discovery never happens, the join times out, and the app tells the user the
 * room doesn't exist. With redundancy 16 the same blackholed run discovers in a few
 * seconds, because it reaches relay.damus.io and eight others.
 *
 * This is NOT the hand-picked list that broke discovery before (see below). It is
 * the same default selection, just cut less aggressively, and that distinction is
 * what makes it safe: the shuffle is deterministic on appId, so the first five URLs
 * are still the same five in the same order. A peer at redundancy 16 and a peer at
 * redundancy 5 therefore still share all five of their relays. Old and new clients
 * interoperate, and there is no flag day.
 *
 * Cost of raising it is 11 more idle WebSockets during matchmaking, which close
 * once everyone has connected.
 */
const RELAY_REDUNDANCY = 16;

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
  const config = { appId: APP_ID, relayConfig: { redundancy: RELAY_REDUNDANCY } };
  if (TURN.length) config.turnConfig = TURN;

  const room = joinRoom(config, roomCode);

  const ctrl  = room.makeAction('ctrl');
  const beat  = room.makeAction('beat');
  const stall = room.makeAction('stall');
  const chat  = room.makeAction('chat');
  const react = room.makeAction('react');
  const meta  = room.makeAction('meta');
  // Mic/camera state, so a tile can show that its person is muted. Purely
  // cosmetic — nothing in sync or playback depends on it.
  const av    = room.makeAction('av');

  /**
   * Room state, issued by the host: has the movie started, and what has the host
   * allowed. Broadcast when it changes and sent targeted on every join, so a
   * newcomer knows within one round trip whether they have walked into a waiting
   * room or a film already in progress.
   */
  const phase = room.makeAction('phase');

  /**
   * "The movie has already started — please let me in", sent to the host, and the
   * host's answer coming back.
   *
   * This is an honour-system door, not a lock. Trystero has already connected the
   * peer at the data layer by the time they knock, and without a server there is
   * nothing that could prevent that. It works because everyone in a movie night
   * is running this same code — it is a doorbell, not authentication, and
   * PROJECT.md says so.
   */
  const knock   = room.makeAction('knock');
  const verdict = room.makeAction('verdict');

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
    // Targeted on join (so a newcomer sees correct badges), broadcast on toggle.
    sendAv:    (d, target) => av.send(d, target ? { target } : undefined),
    // Same pattern: targeted on join so a latecomer learns the room state, and
    // broadcast whenever the host changes it.
    sendPhase: (d, target) => phase.send(d, target ? { target } : undefined),
    sendKnock:   (d, target) => knock.send(d, { target }),
    sendVerdict: (d, target) => verdict.send(d, { target }),

    // ── receivers, assigned by main.js. All get (data, senderPeerId). ──
    onCtrl:     () => {},
    onBeat:     () => {},
    onStall:    () => {},
    onChat:     () => {},
    onReact:    () => {},
    onMeta:     () => {},
    onAv:       () => {},
    onPhase:    () => {},
    onKnock:    () => {},
    onVerdict:  () => {},
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

    /**
     * Can we reach the matchmaking network at all?
     *
     * This distinguishes the two failures that used to wear the same message. If no
     * relay socket is OPEN, we have not searched a room and come up empty — we never
     * got to ask, and saying "that room doesn't exist" is then a straight lie that
     * sends people off checking a room code that was fine all along. That lie cost
     * this project days. See PROJECT.md → Gotchas.
     *
     * `getRelaySockets()` is Trystero's own view of its signaling transport, keyed by
     * URL. Wrapped in a try because it is an internals-adjacent export: a diagnostic
     * must never be the reason a join fails.
     */
    get relays() {
      try {
        const sockets = Object.entries(getRelaySockets());
        const open = sockets.filter(([, ws]) => ws?.readyState === 1).map(([url]) => url);
        return { total: sockets.length, open: open.length, urls: open };
      } catch {
        return { total: 0, open: 0, urls: [], unknown: true };
      }
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
  av.onMessage      = (d, { peerId: from }) => net.onAv(d, from);
  phase.onMessage   = (d, { peerId: from }) => net.onPhase(d, from);
  knock.onMessage   = (d, { peerId: from }) => net.onKnock(d, from);
  verdict.onMessage = (d, { peerId: from }) => net.onVerdict(d, from);

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
