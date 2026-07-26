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

const PING_INTERVAL_MS = 10_000;
const RTT_SAMPLES = 7;

export { selfId };

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

  /** Rolling RTT samples, in ms. We use the median to shrug off outliers. */
  const rttSamples = [];
  let peerId = null;
  let pingTimer = null;

  const net = {
    room,
    selfId,
    roomCode,

    /** The connected peer's id, or null. */
    get peerId() { return peerId; },

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

    addStream: stream => room.addStream(stream),

    leave() {
      clearInterval(pingTimer);
      room.leave();
    },
  };

  // Trystero delivers `(data, {peerId})`. We drop the metadata for most actions
  // because this app is strictly two-person — there is only ever one other peer.
  ctrl.onMessage  = d => net.onCtrl(d);
  beat.onMessage  = d => net.onBeat(d);
  stall.onMessage = d => net.onStall(d);
  chat.onMessage  = d => net.onChat(d);
  react.onMessage = d => net.onReact(d);
  meta.onMessage  = d => net.onMeta(d);

  room.onPeerJoin = id => {
    peerId = id;
    rttSamples.length = 0;   // latency to a new peer is unrelated to the old one
    net.onPeerJoin(id);
    probe();
  };

  room.onPeerLeave = id => {
    if (id === peerId) {
      peerId = null;
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
