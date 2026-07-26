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

**Phase:** Deployed and verified end-to-end over the public internet from the live HTTPS URL.
Still not tested between two *physically separate machines on different networks* — both peers
in every test so far have been browser contexts on one machine.

**Live URL:** https://thetarunshekhawat.github.io/movie-watch/
**Repo:** https://github.com/thetarunshekhawat/movie-watch (public, Pages from `main` root)

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
| Deployed to GitHub Pages | — | ✅ Done — HTTPS live, all assets 200, HTTP 301s to HTTPS |

**Verified working** (two Chromium tabs, same room, real Nostr relay handshake):
peer connection, reference/follower role split, play/pause sync (landed at identical
timestamps), seek sync in both directions, drift detection and proportional
correction, chat with floating bubbles and unread badge, emoji reactions, SRT→VTT
subtitle conversion, per-person volume and subtitle independence, sync-offset
persistence, and the file-mismatch warning.

**Verified on the deployed HTTPS site** (two browser contexts, real Nostr relay handshake,
no local server involved): `window.isSecureContext === true` and `getUserMedia` exposed,
Trystero 0.25.3 loads all four chunks from the CDN, peer discovery and the `meta` name
exchange, play sync (peers landed 40ms apart), seek sync (50ms apart), pause sync (both at
an identical 26.87s), and the no-camera fallback banner.

**Not yet verified:** anything involving a real camera or microphone (auto-duck,
tile rendering, echo behaviour, push-to-talk), fullscreen overlay behaviour, and
connection between two machines on different networks (which is now the *only* path
to a relayed connection, and there is no TURN server configured — see below).

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

**A CSS `display` rule silently defeats the `hidden` attribute.** *(Found on the deployed site
— the lobby stayed on screen after joining.)* The browser implements `hidden` as
`[hidden] { display: none }` in its *user-agent* stylesheet, and any author rule with real
specificity outranks it. `.lobby { display: grid }` meant `lobby.hidden = true` did nothing:
the peer was fully connected and the movie was playing at 26s, but the user only saw the lobby
card with the movie pushed off-screen below it. `#emojiPicker`, `#settingsPanel` and `#chatPanel`
had the same latent defect. **The DOM lies about this** — `el.hidden` reads `true` while
`getComputedStyle(el).display` reads `grid`, so any check that trusts the property passes.
Verify with `getComputedStyle`, or take a screenshot. Fixed globally with
`[hidden] { display: none !important; }` in the reset block of `css/style.css`.

**The free public TURN servers are gone.** *(Found when preparing the first internet test.)*
`openrelay.metered.ca` with the `openrelayproject` credentials was the standard answer for
years and is dead: it now serves plain HTTP on TCP 80, refuses TCP 443, and never answers a
TURN Allocate request on UDP 80/443/3478. Confirmed it was not a local network problem by
getting clean STUN binding responses from `stun.l.google.com` and `stun.cloudflare.com` on the
same machine at the same time. Of the once-standard public relays only `turn.cloudflare.com`
still answers, and it returns 401 — every survivor requires an account, because open relays get
abused as proxies. `TURN` in `net.js` is therefore an empty list, which is *better* than a dead
entry: ICE gathering no longer waits on a server that will never reply. Two ordinary home
connections do not need TURN; mobile hotspots, CGNAT and corporate wifi do.

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

**Cross-network connection untested.** Both peers have only ever been browser contexts on one
machine. The relay path is now not just unproven but *unconfigured* — `TURN` in `net.js` is an
empty list because no credential-free public TURN server exists any more. Two home broadband
connections should still connect directly on STUN alone; a mobile hotspot, CGNAT or corporate
network on either side will hang at "waiting for peer". Diagnose in `chrome://webrtc-internals`:
ICE going `checking` → `failed` with no `relay` candidates is this. Fix by pasting free Metered
credentials into the documented block in `net.js`.

**One Nostr relay retries its cert failure forever.** `wss://schnorr.me/` logged 14
`ERR_CERT_AUTHORITY_INVALID` errors in a two-minute session and never backs off. Harmless to
function — the handshake completes through the other relays — but it buries any real error in
the console, which is exactly when you need the console.

**The controls cannot be clicked by a script.** `#controls` is `pointer-events: none` while the
stage is idle (deliberate auto-hide). A `pointermove` on `#stage` flips it to `auto`, but it
reverts before Playwright's actionability check finishes, so `click` times out anyway. Drive
playback with the keyboard shortcuts instead (`Space`, `←`, `→`) — that is a real user path and
it works reliably under automation.

---

## Next steps

1. **Run it with a real camera** — open two browser windows (one incognito) on the live URL,
   allow camera access, and check auto-duck, the tiles, and fullscreen. This is the largest
   untested area, and headless testing structurally cannot cover it.
2. **Test across two networks** with a real second person. This is the only remaining unknown
   in the connection path.
3. **Decide on TURN before that test.** If either side is on a hotspot, CGNAT or office wifi,
   the session will not connect at all without it. A free Metered account takes two minutes and
   the paste target is documented in `net.js`.
4. Pin the Nostr relay list to drop `schnorr.me`, whose cert failure floods the console.
5. Optional: `showOpenFilePicker()` + IndexedDB to remember the file and resume position between
   sessions, so the movie doesn't have to be re-picked every time.

---

## Changelog

*Newest first.*

### 2026-07-26 — deployed, and verified end-to-end over the internet
- **Shipped to GitHub Pages:** https://thetarunshekhawat.github.io/movie-watch/ — public repo,
  Pages from `main` root. Every asset returns 200 over HTTPS and plain HTTP 301s up to it.
- **Verified the real thing, not a local server:** two browser contexts on the deployed URL
  found each other through the public Nostr relays and stayed in sync. Play landed 40ms apart,
  seek 50ms apart, pause at an identical 26.87s. `isSecureContext` is true and `getUserMedia`
  is exposed, so the camera path is unblocked by hosting.
- **Fixed: the lobby covered the session after joining.** `.lobby { display: grid }` outranked
  the user-agent `[hidden] { display: none }`, so `lobby.hidden = true` had no effect. The peer
  was connected and the movie was playing at 26s while the user still saw only the lobby.
  `#emojiPicker`, `#settingsPanel` and `#chatPanel` shared the defect. Fixed globally with
  `[hidden] { display: none !important; }`.
- **Removed the dead TURN config.** `openrelay.metered.ca` no longer answers TURN at all;
  keeping it only cost ICE gathering time and console noise. `TURN` is now an empty list with
  the paste target for real credentials documented inline.
- Recorded four new entries under **Gotchas & learnings**.

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
