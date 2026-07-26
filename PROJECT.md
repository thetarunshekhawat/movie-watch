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

`sentAt` is `Date.now()` on the sender. It is **not** used as an absolute clock (the two machines'
clocks are not synchronised) — only the RTT-derived `oneWay` estimate is used for compensation.

---

## Gotchas & learnings

> Append to this as new ones are hit. Each one here cost real debugging time.

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

**Cross-network connection untested.** Both peers have only ever been tabs on one machine, where
RTT is ~2ms and no TURN relay is needed. Real-world latency and the TURN fallback are unproven.

---

## Next steps

1. **Run it with a real camera** — open two browser windows (one incognito), allow camera access,
   and check auto-duck, the tiles, and fullscreen. This is the largest untested area.
2. **Confirm `getUserMedia` works over HTTPS on the deployed site** — it is live, but the camera
   prompt has not been exercised there yet.
3. **Test across two networks** with a real second person — this is the only way to exercise the
   TURN fallback path.
4. Consider reordering/pinning Nostr relays to drop the one with the bad certificate.
5. Optional: `showOpenFilePicker()` + IndexedDB to remember the file and resume position between
   sessions, so the movie doesn't have to be re-picked every time.

---

## Changelog

*Newest first.*

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
