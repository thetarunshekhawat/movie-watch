# Movie Watch — PROJECT.md

> **This file is the source of truth for this project.** It is written to be read cold, with zero
> prior context. If it disagrees with the code, the code wins — fix this file.

---

## What this is

A web app that lets two people in different locations watch the same movie together. Each person
plays their **own local copy** of the video file — nothing is streamed or uploaded. Only small
control messages (play, pause, seek) and the two webcam streams cross the network, peer-to-peer.

Built for one specific pair of users, not the public. Optimised for "click a link and it works"
rather than for scale.

**The four things it has to get right:**

1. Pause/play/seek on one side happens on the other side too
2. Both people see each other's faces over the movie
3. Volume and subtitles are strictly per-person
4. It survives a laptop sleeping, a wifi blip, or slightly mismatched video files

---

## Current status

> ⚠️ **The section that rots fastest. Update it whenever anything lands.**

**Phase:** Feature-complete, verified in two-browser testing, and deployed to GitHub Pages.
Not yet tested between two real machines across the internet.

| Component | File | Status |
|---|---|---|
| Project docs | `PROJECT.md`, `CLAUDE.md` | ✅ Done |
| HTML/CSS shell | `index.html`, `css/style.css` | ✅ Done |
| Networking | `js/net.js` | ✅ Done — verified over real Nostr relays |
| Playback sync | `js/sync.js` | ✅ Done — play/pause/seek/drift all verified |
| Player + file handling | `js/player.js` | ✅ Done — codec + audio preflight, fingerprint |
| Subtitles | `js/subs.js` | ✅ Done — SRT→VTT verified |
| Video call + auto-duck | `js/call.js` | ⚠️ Written, **camera path untested** (headless has no camera) |
| Chat + reactions | `js/chat.js` | ✅ Done — verified peer-to-peer |
| Layout / controls | `js/ui.js` | ✅ Done |
| README | `README.md` | ✅ Done |
| Deployed to GitHub Pages | — | ✅ Live at `https://thetarunshekhawat.github.io/movie-watch/` |

**Verified working** (two Chromium tabs, same room, real Nostr relay handshake):
peer connection, reference/follower role split, play/pause sync (landed at identical
timestamps), seek sync in both directions, drift detection and proportional
correction, chat with floating bubbles and unread badge, emoji reactions, SRT→VTT
subtitle conversion, per-person volume and subtitle independence, sync-offset
persistence, and the file-mismatch warning.

**Not yet verified:** anything involving a real camera or microphone (auto-duck,
tile rendering, echo behaviour, push-to-talk), fullscreen overlay behaviour, and
connection between two machines on different networks (the TURN fallback path).

---

## How to run it

```bash
# Any static server works. localhost counts as a secure context,
# so getUserMedia (camera/mic) works without HTTPS.
cd "Movie watch"
python3 -m http.server 8000
```

Then open `http://localhost:8000/?room=test`.

**To test sync alone, without a second person:** open that URL in a normal window *and* an
incognito window. They are two genuinely separate peers, so the entire sync loop is testable solo.
Use a short clip, not a two-hour movie.

**Room codes:** taken from `?room=<code>` in the URL, generated randomly if absent. The share link
is just the page URL with that param. It never expires and never changes.

---

## Architecture

```
   PERSON A's BROWSER                                PERSON B's BROWSER
   ┌──────────────────────────┐                      ┌──────────────────────────┐
   │ <video> ← local file     │                      │ <video> ← local file     │
   │ volume/subs: local only  │                      │ volume/subs: local only  │
   └──────────────────────────┘                      └──────────────────────────┘
              │                                                 │
              └────────── WebRTC, peer-to-peer ─────────────────┘
                    • DataChannel: play/pause/seek/heartbeat/chat
                    • Media:       webcam + mic
                          ▲
                          │ one-time handshake only
                    public Nostr relays (via Trystero)
```

**Stack:** vanilla JS ES modules. No build step, no npm, no bundler. Trystero is loaded straight
from `https://esm.run/trystero` in a `<script type="module">`.

**Hosting:** static files on GitHub Pages. HTTPS is mandatory — `getUserMedia` refuses to run on
plain HTTP.

---

## Decision log

Each entry records *why*, so these don't get re-litigated in a future session.

**Not Google Meet.** The original idea was to embed a Meet call. There is no API for that. The Meet
Add-ons SDK runs *your* app inside Meet in a sandboxed iframe, which fights local file access and
fullscreen control. Building the call directly on WebRTC is less work and reuses the same data
channel for sync messages.

**Trystero instead of our own signaling server.** Trystero does WebRTC matchmaking over public Nostr
relays, so there is no server to run, deploy, or keep awake. The alternative considered was a Node
WebSocket server on the user's laptop behind a cloudflared tunnel; rejected because the laptop is
also the machine playing a fullscreen movie (sleep/wifi drop kills the session mid-film) and because
quick-tunnel URLs change on every restart, forcing a new link to be shared each time. Trystero also
absorbs ~200 lines of subtle WebRTC negotiation (ICE, perfect negotiation, renegotiation on stream
add). **After the handshake, the relays are irrelevant — the session survives if they go down.**

**Fix codecs at the source, not in code.** Browsers cannot play `.mkv`, `.avi`, or AC3/DTS audio.
Rather than handle that in the app, the file is remuxed once with ffmpeg and the resulting MP4 is
the copy that gets shared. Both sides then have byte-identical files. The app still runs a codec
preflight so a wrong file produces a useful error instead of a black screen.

**Only one peer corrects drift.** If both peers correct toward each other they oscillate forever.
The rule is deterministic and needs no negotiation: the peer with the lexicographically smaller
`peerId` is the reference, the other one always corrects.

**Sync messages go over the WebRTC DataChannel, not a server.** Lower latency (~20-80ms) and it
keeps working if the relays vanish.

**Vanilla JS, no build step.** Two-person app, ~1000 lines. A build step would add friction for
zero benefit, and the app must stay easy to tweak mid-movie.

**Rejected: Syncplay + VLC.** It already solves sync for any format with zero code and is well
tested. Rejected as the primary path because it cannot overlay webcams on the movie and requires
installing and configuring two programs on both machines. It remains the fallback if this app
ever proves unreliable.

---

## Message protocol

The contract between `net.js` and every consumer. **Keep this in sync with the code — changing a
payload shape without updating this table is how a future session breaks sync.**

All messages are Trystero actions created with `room.makeAction(name)`.

| Action | Direction | Payload | Purpose |
|---|---|---|---|
| `ctrl` | broadcast | `{type: 'play'\|'pause'\|'seek', mediaTime, seq, sentAt}` | Playback commands. `seq` is a monotonic counter for ordering |
| `beat` | broadcast, every 3s | `{mediaTime, playing, sentAt}` | Heartbeat that drives drift correction |
| `stall` | broadcast | `{stalled: boolean}` | One side is buffering; other side waits |
| `chat` | broadcast | `{text, mediaTime, sentAt}` | Text message; `mediaTime` timestamps it against the movie |
| `react` | broadcast | `{emoji}` | Floating emoji reaction |
| `meta` | broadcast on join | `{name, fingerprint, fileName, duration}` | Identity + file fingerprint for the mismatch check |

| `ping` | request/response | `→ n`, `← n` | RTT probe. Uses `kind: 'request'` |

Every handler receives the **sender's peer id** as a second argument. Use it — do not assume
`net.peerId` (see the ghost-peer entry under Gotchas).

`sentAt` is `Date.now()` on the sender. It is **not** used as an absolute clock (the two machines'
clocks are not synchronised) — only the RTT-derived `oneWay` estimate is used for compensation.

---

## Gotchas & learnings

> Append to this as new ones are hit. Each one here cost real debugging time.

**`room.addStream(stream)` only reaches peers who are ALREADY in the room.** *(Found after the
first real two-machine session — neither person could see the other's camera.)* It is not a
broadcast that new peers pick up. We called it once, immediately after the camera prompt resolved,
and at that moment the room was still empty: granting camera access takes a second, Nostr peer
discovery takes ten. So the call reached nobody, on both sides. Trystero's docs are explicit about
this — you must also re-send targeted on every join:
`room.onPeerJoin = id => room.addStream(stream, {target: id})`. Both paths are needed, because the
peer may arrive either before or after the camera does. **Verified with a canvas-`captureStream`
harness:** without the targeted re-send, neither peer ever fired `onPeerStream`; with it, both did.

**`onPeerJoin` firing does NOT mean the connection is still alive.** Trystero fires it once, when
the handshake activates. Adding a camera stream afterwards triggers an ICE renegotiation that can
fail independently — most likely on a network pair that needs a TURN relay, which we do not have
configured. The result is a green "Connected" dot over a dead peer connection: no video, no sync,
no error. The Settings panel now reports the real `RTCPeerConnection.connectionState` and the
selected ICE candidate pair (`host` = same machine, `srflx`/`prflx` = direct across NAT, `relay` =
TURN), and the status line flips to a failure message when the state goes `failed`. **Do not trust
`onPeerJoin` alone as a health signal.**

**Attribute incoming messages to the actual sender, not `net.peerId`.** A room can hold more than
two peers — a forgotten second tab lingers as a "ghost" until it really closes. Crediting every
message to `net.peerId` corrupts the sequence-number tiebreak in `sync.js` and lets a ghost's
heartbeat drive drift correction. `net.js` now passes Trystero's `{peerId}` through to every
handler, ignores heartbeats from anyone but the nominated peer, and still honours play/pause from
any peer (a command is a real person pressing a real button).

**An author `display` rule silently defeats the `hidden` attribute.** *(Found after deploying —
"Join room" appeared to do nothing.)* The UA stylesheet's `[hidden] { display: none }` is an
**author-vs-UA origin** conflict, not a specificity one: any author rule that sets `display` on
the same element wins, however weak its selector. `.lobby { display: grid }` meant
`lobby.hidden = true` had no effect at all, so the player started up perfectly *behind* a lobby
that never went away. Every panel in this app is toggled with `.hidden`, so
`[hidden] { display: none !important; }` in `css/style.css` is load-bearing — do not remove it,
and do not switch any `hidden`-toggled element to a class that sets `display`.

**Echo suppression is load-bearing.** Applying a remote pause calls `video.pause()`, which fires a
local `pause` event, which broadcasts a pause back — an infinite loop. A module-level
`applyingRemote` flag is set around every programmatic `play()`/`pause()`/`currentTime=` and cleared
on the next macrotask; all local event handlers early-return while it is set. **Nothing else in
sync.js works until this is correct.**

**The Lamport clock must advance on RECEIVE, not just on send.** *(Found in testing — seeks
silently never propagated.)* The first version gave each peer a private counter incremented only
when sending. After the peer sent commands 1 and 2, our own counter was still 0, so our next
command went out as `seq: 1` and the peer rejected it as stale. Fix: `clock = Math.max(clock,
msg.seq)` on every accepted message, so both sides share one ordering. Symptom to watch for is
"play/pause works but seek doesn't", or commands working in one direction only.

**Wire every `net.on*` handler synchronously, before the first `await`.** *(Found in testing — no
file-mismatch warning and no peer name.)* `getUserMedia` shows a permission prompt a real user can
sit on for many seconds, and the peer can connect during that window. Handlers assigned after
`await startCall(...)` miss the `onPeerJoin`/`onMeta` exchange entirely. This is invisible in
headless testing because headless Chrome rejects `getUserMedia` instantly. The incoming peer
media stream is buffered in `pendingStream` for the same reason.

**Codec preflight must check audio separately from video.** *(Found in testing — an AC3 file
passed.)* Video and audio fail independently, and AC3/DTS audio is extremely common in movie rips.
Checking only `videoWidth > 0` lets a file through that plays perfectly but is completely silent.
The working detection is to play muted for ~700ms and read `webkitAudioDecodedByteCount`: it stays
at exactly 0 for an unsupported codec while `webkitVideoDecodedByteCount` climbs into the tens of
thousands. Verified against an AC3 file: 0 audio bytes vs 43KB of video. Note this cannot
distinguish "unsupported codec" from "genuinely silent file", so it warns rather than blocks.

**Modern Chrome does play `.mkv`.** The common advice that MKV never works in browsers is out of
date — recent Chrome reads the Matroska container fine. The reliable killers are the *audio* codec
(AC3/DTS/TrueHD) and HEVC video on platforms without hardware support. Test the file rather than
assuming the extension decides it.

**Drift correction must be proportional, not a fixed rate delta.** *(Found in testing.)* A flat 3%
nudge takes 47 seconds to close 1.4s of drift, and you are visibly out of sync the whole time. The
rate delta is now sized to close the gap in ~4s, clamped to 2–10%. `preservesPitch` is set
explicitly so speeding up time-stretches instead of chipmunking the dialogue.

**A `loadedmetadata` listener bound after `attach()` never fires.** Local files load fast enough
that the event is already gone. Bind the listener, then check `video.readyState >= 1` and call the
handler directly if so.

**Controls are `pointer-events: none` while the stage is idle.** That is intentional (auto-hide),
and real users wake them by moving the mouse toward the button. It does mean scripted clicks fail
unless a `hover` or `pointermove` comes first — relevant when testing with a headless driver.

**Fullscreen must target the container, not the `<video>`.** In fullscreen, only the fullscreened
element and its descendants render. Calling `requestFullscreen()` on the `<video>` makes the webcam
tiles, chat bubbles and control bar all vanish. Call it on the wrapper div that contains them.

**Disable keyboard shortcuts while the chat input has focus.** Otherwise typing a space pauses the
movie for both people.

**Headphones are mandatory.** Movie audio from speakers leaks into the mic and echoes to the other
person. Browser echo-cancellation is tuned for voice, not loud continuous audio, and will not save
this. Not fixable in code.

**`<track>` requires WebVTT, not SRT.** SRT is converted in-browser: prepend `WEBVTT\n\n` and
replace `,` with `.` in timestamps.

**A remux drops embedded subtitles.** Extract them separately with
`ffmpeg -i in.mkv -map 0:s:0 out.srt`.

**`-movflags +faststart` matters.** Without it, seeking in the resulting MP4 is sluggish.

---

## Known issues

**Camera path is entirely unverified.** Headless Chrome has no camera, so `call.js` has never
actually run with a real stream. Auto-duck, the speaking-indicator border, tile drag/resize with
live video, and push-to-talk are all written but untested. The no-camera fallback *is* verified —
it shows a warning banner and sync keeps working.

**Fullscreen overlay is unverified.** The code deliberately fullscreens the `#stage` container
rather than the `<video>`, which is the documented fix, but this has not been observed working.

**One Nostr relay throws cert errors.** `wss://schnorr.me/` fails with
`ERR_CERT_AUTHORITY_INVALID` and spams the console. Harmless — Trystero connects through the other
relays — but it makes the console noisy when debugging.

**No TURN server is configured, and the first real two-machine session failed.** `TURN` in
`net.js` is an empty array, so a peer pair that cannot reach each other directly has no fallback.
In the first Mac↔Windows session both sides showed "Connected" but neither video nor playback sync
worked. The camera half of that is explained and fixed (the `addStream` gotcha above); the sync
half is **not yet explained** — two tabs on one machine sync correctly, including play, pause,
seek and scrub, so the sync engine itself is sound. The leading theory is that the peer connection
died during stream renegotiation for want of a relay. The new Connection/Path readouts in Settings
are there to settle it: if `Path` shows `relay` the connection is going through TURN, if it shows
`srflx`/`prflx` it is direct, and if `Connection` shows `failed` there is no connection at all.
**Next session, open Settings (⚙) on both machines and read those two rows first.**

---

## Next steps

1. **Add a TURN server.** This is now the top item. `TURN` in `net.js` is empty, and the first
   two-machine session failed. Metered (metered.ca) gives 50GB/month free with no card and hands
   back exactly the shape the commented-out block expects.
2. **Re-test across two machines with Settings open** and record `Connection` and `Path` from both
   sides. That is what will explain the sync failure.
3. **Verify the camera fix on two real machines** — both people should now see each other. The fix
   is proven against a synthetic stream but has not run with a real webcam across the internet.
4. Consider reordering/pinning Nostr relays to drop the ones with bad certificates
   (`schnorr.me`, `relay.agorist.space`).
5. Optional: `showOpenFilePicker()` + IndexedDB to remember the file and resume position between
   sessions, so the movie doesn't have to be re-picked every time.

---

## Changelog

*Newest first.*

### 2026-07-26 — first real two-machine session: camera fixed, sync still open

- **Fixed: neither person could see the other's camera.** `room.addStream(stream)` only reaches
  peers already in the room, and we called it right after the camera prompt — seconds before peer
  discovery finished — so it reached nobody on either side. Now also re-sent targeted from
  `onPeerJoin`. Proven with a canvas-`captureStream` harness: 0 streams delivered before, 2 after.
- **Fixed: `net.onMeta` was wired after `await startCall(...)`**, breaking the rule this file
  already documents. Peer name and the file-mismatch warning were lost whenever the peer connected
  during the camera prompt. Moved above the await with the other handlers.
- **Fixed: incoming messages were credited to `net.peerId` rather than the real sender**, which
  corrupts the sequence tiebreak and lets a ghost tab drive drift correction. Sender id is now
  passed through; heartbeats from non-nominated peers are ignored.
- **Added honest connection diagnostics** — `Connection` (real `RTCPeerConnection` state) and
  `Path` (ICE candidate pair) in Settings, plus a status line that reports `failed`/`disconnected`
  instead of leaving the dot green over a dead connection.
- **Still open: playback did not sync between the two machines.** Not reproduced — two tabs on one
  machine sync correctly (play, pause, seek, scrub all propagate, drift < 0.1s). See
  **Known issues**.

### 2026-07-26 — fixed: "Join room" appeared to do nothing

- **Fixed: the lobby never hid.** `.lobby { display: grid }` (author origin) overrode the UA
  `[hidden] { display: none }`, so `$('lobby').hidden = true` was a no-op. The player was starting
  correctly the whole time — it was just rendered behind the lobby, which still covered the screen.
  Added `[hidden] { display: none !important; }` near the top of `css/style.css`.
- Verified against the live GitHub Pages build (lobby stayed `display: grid` with `hidden` set) and
  then end-to-end locally: pick file → Join room → lobby `none`, stage `block`, no page errors
  beyond the known `schnorr.me` relay noise.
- New entry under **Gotchas & learnings**.

### 2026-07-26 — all components built and verified
- Built the full app: lobby, player, sync engine, WebRTC call, chat, reactions, subtitles.
- **Fixed: seeks never propagated.** The logical clock only advanced on send, so each peer's
  counter fell behind and valid commands were rejected as stale. Now a proper Lamport clock.
- **Fixed: peer metadata was lost** when a peer connected during the `getUserMedia` prompt. All
  network handlers are now wired synchronously before any `await`.
- **Fixed: AC3 audio passed codec preflight**, which would have produced a silent movie. Preflight
  now decodes muted and checks `webkitAudioDecodedByteCount`.
- **Fixed: drift correction was far too slow** (fixed 3% delta → 47s to close 1.4s). Now
  proportional, targeting ~4s, clamped to 2–10%, with `preservesPitch`.
- **Fixed: total duration displayed as 0:00** — `loadedmetadata` had already fired before the
  listener was bound.
- Recorded six new entries under **Gotchas & learnings**.

### 2026-07-26 — project created
- Architecture decided (Trystero + WebRTC, local file playback, GitHub Pages).
- `PROJECT.md` and `CLAUDE.md` written ahead of any code so decisions are captured while fresh.
