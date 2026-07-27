# Movie Watch — PROJECT.md

> **This file is the source of truth for this project.** It is written to be read cold, with zero
> prior context. If it disagrees with the code, the code wins — fix this file.

---

## What this is

A web app that lets a small group in different locations watch the same movie together. Each person
plays their **own local copy** of the video file — nothing is streamed or uploaded. Only small
control messages (play, pause, seek) and the webcam streams cross the network, peer-to-peer.

Built for one specific group of friends, not the public. Optimised for "click a link and it
works" rather than for scale — a room holds about six people before the full peer mesh gets
expensive.

**The four things it has to get right:**

1. Pause/play/seek by anyone happens for everyone
2. You can always see who is actually in the room
3. Volume and subtitles are strictly per-person
4. It survives a laptop sleeping, a wifi blip, or slightly mismatched video files

---

## Current status

> ⚠️ **The section that rots fastest. Update it whenever anything lands.**

**Phase:** The app is now a *room you enter*, not a form you submit — create/join, a waiting room
where people gather and talk before the film, and host approval for anyone arriving late. Verified
end-to-end with three live peers. Deployed to GitHub Pages. **Still never verified between two real
machines across the internet** — every attempt so far ended with each browser connected to a stale
window on its own machine.

| Component | File | Status |
|---|---|---|
| Project docs | `PROJECT.md`, `CLAUDE.md` | ✅ Done |
| HTML/CSS shell | `index.html`, `css/style.css` | ✅ Done — rebuilt in the depoluxe.xyz visual language (EB Garamond, monochrome, square, hairline rules) |
| Ambient frame stack | `js/frames.js`, `js/frames-data.js` | ✅ Done — canvas corner stack on the landing screen and in the waiting room. **Placeholder slates only; real stills not supplied yet** |
| Typeface | `fonts/` | ✅ Done — EB Garamond self-hosted, 4 subsetted woff2 + OFL |
| Networking | `js/net.js` | ✅ Done — verified over real Nostr relays |
| Playback sync | `js/sync.js` | ✅ Done — play/pause/seek/drift all verified, plus a host-only control lock |
| Player + file handling | `js/player.js` | ✅ Done — codec + audio preflight, fingerprint |
| Subtitles | `js/subs.js` | ✅ Done — SRT→VTT verified, loadable at any point via CC or drag-and-drop |
| Video call + auto-duck | `js/call.js` | ✅ On demand at any moment (no opt-in checkbox). Verified with synthetic cameras — tiles, badges, fade, drag, toggle on/off. Real webcams and cross-network still unproven |
| Chat + reactions | `js/chat.js` | ✅ Done — verified peer-to-peer, works in the waiting room too |
| Entrance, waiting room, host controls | `js/main.js` | ✅ Done — create/join, room-existence probe, phases, knock-to-enter |
| Layout / controls | `js/ui.js` | ✅ Done — includes click-outside panel dismissal |
| README | `README.md` | ✅ Done |
| Deployed to GitHub Pages | — | ✅ Live at `https://thetarunshekhawat.github.io/movie-watch/` |

**Verified working** (three Chromium tabs, same room, real Nostr relay handshake):
peer discovery, roster agreement and host election across all three, host handover
when the host leaves, "Start for everyone" landing within 0.25s, play/pause/seek
from any participant propagating to everyone, drift detection and proportional
correction, chat attributed per sender with floating bubbles and unread badge,
emoji reactions, SRT→VTT subtitle conversion, per-person volume and subtitle
independence, sync-offset persistence, the file-mismatch flag, and dynamic peer
tiles created/labelled/removed cleanly.

**Camera path verified 3-way** by substituting a canvas `captureStream` for
`getUserMedia` before joining, which exercises the real code path
(`startCall` → `addStream` → targeted re-send on join → `onPeerStream` → tile):
all three peers received both other streams, tiles were labelled correctly, and
playback sync held while three cameras were streaming.

**Tile behaviour verified two-way** with the same harness (two tabs, synthetic
camera + oscillator mic): a peer tile dragged from `top: 150px` to `top: 570px`
and stayed inside the stage, the speaking outline appeared on the talker's *own*
tile and on the listener's tile for them, the movie ducked to 0.3 for the
listener only, the 🔇 badge and camera-off placeholder crossed the wire in both
directions, the fade slider dimmed every tile to 0.3 with hover restoring 1.0,
the size slider resized both tiles together, and subtitles moved from line 92 to
line 80 when the control bar appeared and back when it hid.

**Entrance, waiting room and host controls verified** with three live peers on
real Nostr relays (2026-07-27):

| Checked | Result |
|---|---|
| Create a room | Lands in the waiting room as HOST, playback controls disabled |
| Join a room nobody is in | *"Room X doesn't exist"* after the 12s probe, with Try again / Back |
| Join a real room | Found in <3s, both rosters agreed, `Alice HOST` + `Bob YOU` |
| Host presses Start | Both left the waiting room and played, 1.98s vs 2.04s |
| Non-host pause + seek | Propagated to the host, both within 0.02s |
| Host-only playback | Follower's play/scrub disabled with a reason; **a direct `video.play()` from the console still could not move the room** |
| Late joiner | *"Movie has already started, request sent to Alice"*; host got the popup; Allow → admitted and synced to 60.00 on both |
| Decline | *"Not right now — Alice declined the request"*, stayed outside |
| Late joining switched off | *"This room is closed"*, and the host was never interrupted |
| Click-outside | Chat/roster/emoji dismiss on a video click; the control bar does not dismiss; the owning button still toggles cleanly |
| Subtitles mid-movie | CC with no track opens the picker; SRT loaded 2 cues; a dropped `.vtt` replaced it |
| Camera on demand | 📷 acquired the stream mid-session, tile appeared, off/on flipped `track.enabled` and the 🔇 badge |

Zero console errors across the whole session.

**Not yet verified:** a physical camera or microphone (so echo behaviour and
push-to-talk are still untested), fullscreen overlay behaviour, and — the big
one — any connection between two machines on different networks.

---

## How to run it

```bash
# Any static server works. localhost counts as a secure context,
# so getUserMedia (camera/mic) works without HTTPS.
cd "Movie watch"
python3 -m http.server 8000
```

Then open `http://localhost:8000/` and pick **Create a room**.

**To test alone, without a second person:** create a room in a normal window, then open the
`?room=` link in an incognito window and **Join a room**. They are two genuinely separate peers, so
the whole loop — probe, waiting room, start, sync, and (once the first window has started the film)
the knock-and-approve flow — is testable solo. Use a short clip, not a two-hour movie.

Do not try to drive more than two tabs of the same browser: a backgrounded tab gets throttled hard
enough to drop its peer connections entirely (see **Known issues**).

**Room codes:** `?room=<code>` in the URL opens the join form with the code filled in. Creating a
room reuses your last code, or generates one; either is editable. The share link is just the page
URL with that param. It never expires and never changes — but a room only *exists* while at least
one person is in it, which is what the join probe is checking.

---

## Architecture

```
   HOST's BROWSER                                    EVERYONE ELSE (up to ~5 more)
   ┌──────────────────────────┐                      ┌──────────────────────────┐
   │ <video> ← local file     │                      │ <video> ← local file     │
   │ drift reference          │                      │ corrects toward the host │
   │ volume/subs: local only  │                      │ volume/subs: local only  │
   └──────────────────────────┘                      └──────────────────────────┘
              │                                                 │
              └──── WebRTC full mesh, peer-to-peer ─────────────┘
                    • DataChannel: play/pause/seek/heartbeat/chat
                    •              room phase, host policy, join requests
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

**~~Cameras are opt-in, off by default.~~ REVERSED 2026-07-27 — see the next entry.** The original
reasoning still holds and is why the replacement is shaped the way it is: sending a webcam stream
forces an ICE renegotiation, and with no TURN relay that can kill a peer connection which was
working perfectly for data — taking chat, reactions, presence and playback sync down with it.

**The camera checkbox is gone; the camera is on demand instead.** The checkbox was a one-way door:
forget to tick it and you could not get video for the whole session, which is a worse and more
common failure than the renegotiation it was guarding against. Now `startCall()` never touches
`getUserMedia` — `call.enable()` does, and 📷/🎙 call it on first press, so the camera can go on
and off at any point in the film. The renegotiation risk is handled by *timing* rather than by
abstinence: the camera comes up automatically **in the waiting room**, before the movie starts, so
if a network pair cannot survive the renegotiation it fails while people are still saying hello
rather than an hour into the film. And because the failure is now predictable, it is also reported:
a `failed`/`disconnected` state within 20s of a camera going on raises a banner naming the camera
as the likely cause, with a **Rejoin without video** button that sets `mw:noAutoCam` in
sessionStorage and reloads. A session that never turns a camera on still never renegotiates.

**"Does this room exist?" can only mean "is anyone in it right now".** There is no server and no
room registry, so joining runs a 12-second probe for any Trystero peer and reports the room missing
if none answers. 12s is deliberately generous — Nostr discovery routinely takes the best part of
ten — and the failure screen offers **Try again** rather than only a dead end, because wrongly
telling someone a real room does not exist is the worse error. Abandoning the attempt calls
`net.leave()`; skipping that would leave exactly the ghost peer that cost this project an evening.

**A waiting room, and it is the stage rather than a separate screen.** `#stage` carries a
`.phase-lobby` class and shows the `#greenRoom` overlay; the movie is simply not playing yet. That
reuses the tiles, chat, bubbles, roster, banners and fullscreen exactly as they already work — a
separate screen would have meant moving those DOM nodes between parents for no gain. `#selfTile`
moved inside the tile container (`#peerTiles` → `#tiles`) so the waiting room can lay every face
out in one grid and the movie phase can hand them straight back to floating.

**Late arrivals knock; the host answers.** Joining a room whose phase is already `playing` sends a
`knock` to the host and holds the newcomer on the status card — `createSync` is never called, so a
half-admitted person can never drive playback. The host gets a small corner card, not a modal: they
are watching a film, and nothing pauses. The host's *Let people join after the movie starts* toggle
decides whether they are interrupted at all; with it off the knock is auto-declined and the host
never sees it. **This is a doorbell, not a lock** — Trystero has already connected the peer at the
data layer, and without a server nothing could prevent that. It works because everyone runs this
same code.

**Playback policy is enforced on receive, not just on send.** *Who can control playback* defaults
to Everyone (the existing decision — this is friends watching a film, not a lecture). Set to *Host
only*, `sync.js` blocks the broadcast **and** drops incoming `ctrl` from anyone who is not the host,
and it also blocks the local action so a locked-out person cannot silently desync themselves.
Verified by bypassing the UI entirely with a console `video.play()`: the room did not move.

**Rejected: manual host transfer.** The host is derived from `joinedAt`, never stored, so it hands
over by itself. A manual override fights that and can disagree between machines.

**Everyone corrects toward the host; the host never corrects.** If peers correct toward each other
they oscillate forever, and with three or more people chasing several clocks at once nothing ever
settles. One reference is the only stable arrangement.

**The host is the earliest joiner, recomputed rather than stored.** Each person broadcasts a
`joinedAt` wall-clock stamp in `meta`; the host is the smallest, tie-broken by peer id so every
machine derives the same answer with no negotiation and no election protocol. Recomputing means
the role simply moves to the next-earliest person when the host leaves — verified. Peers whose
`meta` has not arrived are excluded from the election, otherwise the host flaps as people connect.
This compares clocks across machines, which is normally forbidden here (see `sentAt`), and it is
fine only because people join minutes apart and seconds of skew cannot reorder that. **Never use
`joinedAt` for playback timing.**

**Anyone can pause and seek; only the host can start the room together.** Deliberate — this is two
friends watching a film, not a lecture. "Start for everyone" reuses the existing `play` command
rather than adding a message type, because `play` already carries the sender's position and is
latency-compensated on arrival.

**Sync messages go over the WebRTC DataChannel, not a server.** Lower latency (~20-80ms) and it
keeps working if the relays vanish.

**Vanilla JS, no build step.** Two-person app, ~1000 lines. A build step would add friction for
zero benefit, and the app must stay easy to tweak mid-movie.

**Rejected: Syncplay + VLC.** It already solves sync for any format with zero code and is well
tested. Rejected as the primary path because it cannot overlay webcams on the movie and requires
installing and configuring two programs on both machines. It remains the fallback if this app
ever proves unreliable.

---

### The whole interface is modelled on depoluxe.xyz

*Because the previous one looked generated rather than designed.* Concretely, what read as
"AI-generated" was: 9–18px rounded corners everywhere, a coral `#ff6b6b` + teal `#4ecdc4` accent
pair, two radial-gradient blobs behind the lobby, `system-ui`, and emoji standing in for icons.
None of those are individually wrong; together they are the house style of every generated
starter template, and this is an app for watching *films*.

The replacement language is taken from depoluxe.xyz, a film-production portfolio: EB Garamond,
pure black and white, **zero border radius, zero box-shadow**, 1px hairline rules instead of card
borders, roman-numeral counters, italic titles in typographic quotes, and letterspaced uppercase
micro-labels. `--radius` and `--shadow` still exist as tokens but are set to `0`/`none`, so any
rule missed in the rewrite degrades to the correct flat square result instead of reintroducing
the look.

Their source map is public, so the effect below was ported from their actual source rather than
guessed at from the rendered page.

### EB Garamond is self-hosted, not linked from Google Fonts

*Because the design IS the typeface, and a visible FOUT on the landing screen reads as the
product being broken.* Google Fonts is a three-hop chain you cannot flatten or preload through
(`HTML → googleapis → gstatic → woff2`); self-hosted, the font is a first-round-trip preload on
an already-warm connection. It also removes a second third-party dependency — Trystero failing
means "no watch party", but the font failing would mean "unreadable watch party", and that is not
a risk worth outsourcing for 90KB.

This does **not** breach the no-build-step rule. The files were taken from Google's own CSS
endpoint (so the subsetting and `unicode-range` values are theirs) and are committed verbatim;
GitHub Pages serves them with no tooling involved. A metric-matched `EBG Fallback` face with
`size-adjust`/`ascent-override` means the swap causes no reflow. Licence in `fonts/OFL.txt`.

### The ambient stack is ONE canvas that gets re-parented, not two canvases

*Because it has to render on both the lobby screen and the stage, and those are siblings.*
Three alternatives were rejected for concrete reasons:

- **A canvas inside `#lobby`** — `.lobby` is `overflow-y: auto`, so on a short window the setup
  card scrolls and an absolutely-positioned child scrolls with it. The background would slide.
- **`position: fixed`** — a fullscreened element becomes the containing block for `fixed`
  descendants in Chrome, so the layer would jump the moment someone pressed **F** in the waiting
  room.
- **Two canvases** — two backing stores, and the animation phase resets at the seam between
  screens.

Moving a `<canvas>` in the DOM preserves its bitmap and context (only assigning `width`/`height`
clears them), so re-parenting is close to free. `z-index: 1` is correct in both parents: below
`#lobby` (z-index 2), and inside `#stage` above the in-flow `<video>` but below `#tiles` (30).
This also satisfies the fullscreen rule — on the player screen the layer is a descendant of
`#stage`.

### The stack advances by dwell-and-step, and stops for good when the film starts

*Because a constant conveyor reads as a screensaver and a stepped one reads as editing.* It holds
a composition for 2.4s, then eases through exactly one frame over 1.6s. The side benefit is
large: during the dwell nothing changes, so the render loop skips the draw entirely — most frames
cost one rAF callback and a float comparison.

It never resumes after the film starts. The canvas is faded out over 0.8s, removed from the DOM,
and every decoded bitmap dropped, so the second rAF loop is gone before the first frame of the
film is decoded and nothing competes with the movie.

### Falloff `k = 0.72`, with cumulative packing rather than depoluxe's telescoping form

*Because we want two or three frames reading as large; depoluxe wants one.* Their size rule is
`BASE · 0.5^|distance|`, and their placement telescopes — which packs edge-to-edge **only** at
exactly `k = 0.5`. A gentler `k` there would leave gaps.

Ours positions each frame by the cumulative size of everything between it and the corner:

    cum(x) = BASE · (1 - k^x) / (1 - k)

This is the geometric partial sum extended to real `x`. It equals the discrete sum exactly at
integers (`cum(0)=0`, `cum(1)=BASE`, `cum(2)=BASE(1+k)`) and is smooth in between, so the stack
packs perfectly for *any* `k` — which is what buys the freedom to choose 0.72.

Two knobs exist because a gentle falloff keeps frames legible for longer, which is the point but
also the hazard: `MAX_RADIUS: 4` caps how far the arms reach so the composition stays a *corner*
rather than filling the page, and `SLOTS_MIN: 12` guarantees the wrap seam falls outside the cull
radius (it must hold `N ≥ 2R + 2`, or a frame pops back into view at the seam).

### Icons are mixed on purpose: pictogram, word, or emoji

*Because a single rule produces a worse bar than three honest ones.* A hairline SVG where a
universal convention exists (transport, mic, camera, duck, gear, fullscreen); a letterspaced word
where none does (`CC`, `ROOM`, `CHAT`); and emoji left alone for the reaction button, because the
thing it produces *is* an emoji. Every button keeps its `title` and gains an `aria-label`, so the
accessible name stays a full sentence even where the visible label is three letters.


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
| `meta` | targeted on every join, + broadcast | `{name, joinedAt, fingerprint, fileName, duration}` | Identity, roster and host election. `joinedAt` is the sender's wall clock |
| `av` | targeted on every join, + broadcast on toggle | `{mic: boolean, cam: boolean}` | Mic/camera state, drawn as a 🔇 badge and the camera-off placeholder on that person's tile. Cosmetic only — nothing in sync depends on it |
| `phase` | targeted on every join, + broadcast on change | `{phase: 'lobby'\|'playing', policy: {control: 'everyone'\|'host', allowLate: boolean}}` | Whether the film has started, plus the host's policy. **Only the host's copy counts** |
| `knock` | targeted → host | `{name}` | "The movie has started, please let me in." Sent by someone who has NOT sent `meta` yet |
| `verdict` | targeted → knocker | `{allowed: boolean, reason?: 'closed'}` | The host's answer. `reason: 'closed'` means late joining is switched off, not that they were personally refused |

| `ping` | request/response | `→ n`, `← n` | RTT probe. Uses `kind: 'request'` |

Every handler receives the **sender's peer id** as a second argument. Use it — do not assume
`net.peerId` (see the ghost-peer entry under Gotchas).

`sentAt` is `Date.now()` on the sender. It is **not** used as an absolute clock (the two machines'
clocks are not synchronised) — only the RTT-derived `oneWay` estimate is used for compensation.

---

## Gotchas & learnings

> Append to this as new ones are hit. Each one here cost real debugging time.

**A `const` used by a function that runs early in the same scope throws — and the symptom looks
like a completely unrelated feature being broken.** *(Hit three times in one sitting while building
the entrance flow.)* `main.js` is one long function that calls `admit()` near the top and declares
helpers further down. `const tag = ...`, `const shareLink = ...` and `let cameraOnAt` were all
still in their temporal dead zone when the early code reached them, and the resulting
`ReferenceError` propagated silently out of a promise: the stage appeared but the waiting room did
not, and clicking "Join room" did nothing because `enterSetup()` had thrown halfway through, after
setting the title but before `showCard()`. Nothing appeared in the console — the error surfaced
only in the `.catch()` that writes to `#lobbyError`, on a card that was hidden.
**Rules:** anything reachable from `admit()` or from module top-level is a `function` declaration,
not a `const` arrow; state written by early code is declared at the very top of the scope; and the
one top-level bootstrap call (`if (urlRoom) enterSetup('join')`) is the last statement in its
section, not the first.

**`position: static` on a tile strands its label at the corner of the screen.** *(Caught in a
screenshot, not by any assertion.)* The waiting-room grid neutralises the floating layout with
`position: … !important` — necessary, because `placeTile()` writes `left`/`top` inline and only an
important declaration outranks an inline one. The first attempt used `static`, which removes the
tile as a containing block, so `.tile-label` and `.tile-badges` — both `position: absolute` — leapt
up to `#tiles` and rendered at the far left of the stage, detached from the face they name. Use
`relative`, and neutralise `left`/`top`/`right` explicitly or the inline values come back as
relative nudges. **Never make an element `static` when its children are positioned against it.**

**Browsers cache `style.css` hard enough to fake a broken CSS fix.** After changing the tile rule,
the computed style still read the *previous* value through several reloads, which reads exactly like
an `!important` that isn't winning. `location.reload(true)` or a cache-busting query confirms which
it is. Check this before rewriting a selector that was already correct.

**A stale window on your own machine will impersonate your partner.** *(Cost an entire evening.)*
Trystero connects you to every peer in the room, including a Movie Watch window you left open in
another browser hours ago. `net.js` nominates the most recently joined peer, so the local ghost
wins — and everything then looks healthy: green dot, "Connected", 2ms latency, drift correction
running. It is all real. It is just talking to itself. The tell is the **Path** row: `host/host`
means both ends reached each other over local interface addresses, which is impossible across the
internet. The second tell is the **Watching with** row showing your own name back at you. Both
rows exist because neither was there when this happened, and without them the failure is
indistinguishable from a broken sync engine. `pagehide` is now wired alongside `beforeunload` to
cut down on ghosts in the first place, but it cannot catch every case — a crashed or force-quit
browser always leaves one.

**Do NOT pin a hand-picked Nostr relay list.** *(Tried it; it broke discovery completely — nobody
could connect at all.)* The trap is that "the WebSocket opens" is not the same as "this relay
works". Trystero signals over Nostr *ephemeral* events, and plenty of relays accept a connection
while silently declining to forward them — caching and aggregator services especially. Four of the
six relays in that attempt (`relay.primal.net`, `relay.snort.social`, `nostr.mom`, `offchain.pub`)
are absent from Trystero's own 47-relay default list for exactly that reason, and with
`redundancy: 4` a peer could draw four duds and be unreachable. The cert errors thrown by a couple
of the defaults are console noise, not a functional problem; redundancy exists to absorb that.
Leave relay selection alone unless you can test end-to-end discovery, from two networks, against
any replacement list.

**A zero-height wrapper silently pins an absolutely-positioned child to the top edge.** *(This is
why peer tiles could only ever be dragged sideways.)* `#peerTiles` was an unstyled `<div>`, so it
had height 0 — but the tiles inside it are `position: absolute`, so they were laid out against
`#stage` and looked fine. The drag code clamped against `tile.parentElement`, i.e. that 0-height
box: `clamp(top, 0, 0 - h)` reduces to `0` for every input, so vertical drags did nothing while
horizontal drags worked perfectly. A half-working drag is a much worse symptom than a broken one —
it reads as a deliberate constraint. Two rules now: `#peerTiles` is a real full-stage layer
(`position: absolute; inset: 0; pointer-events: none`, with `pointer-events: auto` back on the
tiles), and drag code clamps against `offsetParent`, which is by definition the box the coordinates
are relative to. **Never clamp absolute positioning against `parentElement`.**

**Your own tile needs its own analyser, excluded from ducking.** The speaking indicator is driven
by `duck.watch()`, which was only ever called for incoming peer streams — so your own tile never
lit up and there was no way to tell whether your mic was live. The local stream is now watched
too, with a `selfOnly` flag that keeps it out of the `anySpeaking` test: your voice must light your
tile without ducking your own movie. The AudioContext is also created before any click has
happened (the camera resolves during load), so it starts `suspended` and reads pure silence unless
it is resumed — which is why the indicator can look broken in a tab you have not clicked yet.

**Mute state cannot be detected locally; the peer has to tell you.** A remote track whose sender
set `enabled = false` still arrives as a live track that simply carries silence, indistinguishable
from someone being quiet. Hence the `av` message. It is sent targeted on join as well as broadcast
on toggle, because a newcomer would otherwise assume everyone's mic is on.

**Name and stream arrive in either order, so both paths must label the tile.** *(Found in the
camera end-to-end test — every tile rendered video with a blank name.)* A peer tile is only created
when their stream arrives, so a `meta` that landed first called `setPeerName` on a tile that did
not exist yet and the name was silently dropped. Both `onStream` and the roster render now set it.

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

**`stage.hidden = false` runs ~70 lines and several `await`s before `applyPhase()` sets the
phase class.** *(Found while adding the ambient layer; it produced a black flash on entry.)*
`admit()` reveals the stage immediately, but the `.phase-lobby` class that the waiting-room
layout depends on was only applied much later, after `attach()`, `loadSubtitles()` and
`startCall()` had all been awaited. For that entire window the stage is visible with no phase
class — so the black, not-yet-started `<video>` paints over everything and `#greenRoom` is still
`hidden`. With a large movie file the window is clearly visible. The fix is to set the class in
the *same synchronous block* as the reveal, using the `startPhase` argument; it is idempotent
with the later `applyPhase()` call. **Anything that must be visible on entry has to be set before
the first `await`, not after it.**

**`applyPhase()` is the only funnel every "the movie starts now" path passes through.**
*(Established while deciding where to stop the ambient animation.)* There are four such paths and
`#startMovieBtn` is only the first: the host clicking start; a guest receiving the `phase`
message in `net.onPhase`; the safety net in `onRemoteCtrl` that catches a bare `play` arriving
with no phase message; and someone admitted mid-film via `admit({startPhase:'playing'})`, who
**never calls `enterPlaying()` at all**. All four reach `applyPhase()`. Hooking the button would
have worked only for the host and silently failed for every guest — verified by driving two
windows and confirming the guest, who never touched the button, retired its layer correctly.

**Assigning `canvas.width` or `canvas.height` clears the bitmap and resets all context state.**
Combined with `ResizeObserver` firing repeatedly with *identical* box dimensions during the
fullscreen transition, a naive resize handler blanks the canvas several times per fullscreen
toggle. The handler must compare the measured size against the current one and return early when
nothing changed.

**`ctx.fillText` silently falls back to the system serif if the webfont has not loaded yet.**
There is no error and no reflow to notice — the labels are simply in the wrong typeface. The
first draw is gated on `document.fonts.load()` behind a 1.5s timeout, and a redraw is queued on
`document.fonts.ready`. This is **mandatory** in reduced-motion mode, where exactly one frame is
ever drawn and would otherwise be stuck in the fallback for the whole session.

**A module import ignores a cache-busting query on the HTML.** *(Cost several confusing
iterations.)* Reloading `index.html?cb=123` re-fetches the HTML but `import './frames.js'`
resolves to the same URL as before and is served from cache, so edits appear to have no effect —
which reads exactly like a broken code path. This is the module-level twin of the documented
`style.css` caching trap. Serve with `Cache-Control: no-store` while iterating, and remember that
restarting the browser process may be needed to clear a driver-level cache too.


## Known issues

**The camera now renegotiates every session, by design.** The waiting room calls `call.enable()`
automatically, so every session adds a media stream to every peer connection where previously the
default was data-only. On a network pair that needs TURN this can break a link that was working.
It is deliberate (see the decision log), it happens at the least damaging moment, and it announces
itself with a **Rejoin without video** button — but it is a real, accepted regression in
robustness, and it is the first thing to suspect if a session that used to work stops working.

**The door is a doorbell, not a lock.** A late joiner is connected at the data layer before they
knock, and *Let people join after the movie starts* is honoured by their client, not enforced by
ours. Nothing short of a server could change that. Fine for a group of friends; do not describe it
as access control.

**Three peers in one headless browser will not stay meshed.** During verification, two background
tabs lost their peer connections entirely and each re-elected itself host, because Chrome throttles
background tabs hard enough to stall Trystero's signaling and time out ICE. Only the foreground tab
stayed healthy. Every multi-peer check has to be read *while the tabs are connected*; a stale
reading after tab-switching says nothing. Not a product bug — real people have their own windows —
but it makes automated multi-peer testing unreliable past two tabs.

**No real camera or microphone has ever been used.** Headless Chrome has none, so every camera
test substitutes a canvas `captureStream` for video and an oscillator for audio. That exercises
the real code path end to end — auto-duck, speaking indicators, tile drag/resize, badges — but it
says nothing about echo behaviour, `SPEAK_THRESHOLD` against a real voice in a real room, or
push-to-talk, which remains untested. The no-camera fallback *is* verified — it shows a warning
banner and sync keeps working.

**Fullscreen overlay is unverified.** The code deliberately fullscreens the `#stage` container
rather than the `<video>`, which is the documented fix, but this has not been observed working.

**One Nostr relay throws cert errors.** `wss://schnorr.me/` fails with
`ERR_CERT_AUTHORITY_INVALID` and spams the console. Harmless — Trystero connects through the other
relays — but it makes the console noisy when debugging.

**The two machines have never yet connected to each other.** Every session so far ended with each
browser talking to a stale window on its own laptop (see the ghost-peer gotcha). So there is still
**no evidence either way** about whether a direct cross-network path works, and none about whether
TURN is needed. `TURN` in `net.js` is an empty array.

Read the Settings (⚙) rows to tell the cases apart:

| Reading | Means |
|---|---|
| `Path: host/host` | Same machine or same LAN. Across the internet this is a ghost window. |
| `Path: srflx/srflx` or `prflx` | Genuine direct connection between the two machines. |
| `Path: relay/…` | Going through a TURN server. |
| `Peers in room: 0` | The two never found each other — signaling or discovery problem. |
| `Connection: failed` | Found each other, but no usable network route. **This** is what TURN fixes. |

---

**The ambient stack ships with placeholder slates, not real stills.**
`js/frames-data.js` carries twelve film titles and no images — every frame draws as a numbered
slate with crop marks. That is a deliberate designed state rather than a broken one, but it is
not the finished look. Drop landscape images into `img/frames/` and set `src` on each entry; the
composition does not move when they arrive.

**Fullscreen overlay behaviour is still unverified, and now has one more thing riding on it.**
The ambient layer was deliberately made a re-parented descendant of `#stage` (rather than
`position: fixed`) precisely so it survives fullscreen, and the DOM containment has been
confirmed — but as with every other overlay, actual rendering in fullscreen has never been
observed. Headless Chromium is not a useful test for this.


## Next steps

1. **Supply the real movie stills.** `js/frames-data.js` has twelve placeholder titles and no
   images. Drop landscape files into `img/frames/`, set `src` on each entry, then re-tune `K`
   (0.68–0.74) and `DWELL_MS` against real pictures — the current values were chosen against
   empty slates and may want adjusting once there is actual luminance in the frames.
2. **Re-test with every other Movie Watch window closed on both machines.** Quit both browsers
   completely first — that is the only way to be sure no ghost survives. Then check the **Path**
   row: anything other than `host/host` means the two laptops have genuinely found each other.
   Only once that is true is there any evidence about whether TURN is needed.
3. **Add a TURN server** if, with ghosts gone, the two machines still never connect (`Peers in
   room: 0`) or the connection reports `failed`. `TURN` in `net.js` is empty.
   Metered (metered.ca) gives 50GB/month free with no card and hands back exactly the shape the
   commented-out block expects.
3. **Verify the camera on two real machines** once TURN is in — now more urgent than it was, since
   the camera is no longer opt-in and every session renegotiates. If it turns out to break
   cross-network links routinely, the fix is not to bring the checkbox back but to negotiate the
   media transceivers up front (a silent placeholder stream at join, swapped for the real tracks
   with Trystero's `replaceTrack`), which avoids renegotiation entirely.
4. **Try the waiting room with real people.** It has only ever been driven by a script. The open
   questions are whether 12s feels too long to wait on the "looking for room" card, and whether a
   host watching a film actually notices the corner join-request card.
4. **Check `SPEAK_THRESHOLD` (0.045) against a real microphone.** Every speaking-indicator test so
   far has used an oscillator at a fixed level, which says nothing about whether a normal speaking
   voice crosses the line — or whether movie audio bleeding into the mic crosses it constantly.
5. Consider reordering/pinning Nostr relays to drop the ones with bad certificates
   (`schnorr.me`, `relay.agorist.space`).
6. Optional: `showOpenFilePicker()` + IndexedDB to remember the file and resume position between
   sessions, so the movie doesn't have to be re-picked every time.

---

## Changelog

*Newest first.*

### 2026-07-27 — the interface rebuilt in the depoluxe.xyz language, with an ambient frame stack

The app looked generated. It now looks designed, and the landing screen has something to say.

- **New typeface.** EB Garamond, self-hosted (`fonts/`, 4 subsetted woff2 + OFL), with a
  metric-matched fallback so the swap causes no reflow.
- **New token set.** Pure black and white, `--radius: 0`, `--shadow: none`, hairline rules,
  a fluid `clamp(13px, .95vw, 22px)` root with everything downstream in rem, and the z-index
  ladder promoted to `--z-*` tokens as a single source of truth.
- **New ambient frame stack** (`js/frames.js` + `js/frames-data.js`): a 2D-canvas contact sheet
  of movie stills in the bottom-left corner, each sized `BASE · 0.72^|distance|` and packed by
  cumulative geometric sum, advancing on its own with no scroll. Ported from depoluxe's
  `InfiniteScroll__HomeItem.js` via their public source map, then re-derived so the packing works
  at a gentler falloff. Runs on the landing screen, follows you into the waiting room, and is
  removed for good when the film starts.
- **Waiting room re-laid-out**: frame stack bottom-left, participant cameras **upper-right**,
  room text centred between them.
- **Icons**: hairline SVG for transport/mic/camera/duck/gear/fullscreen, letterspaced words for
  `CC`/`ROOM`/`CHAT`, emoji kept only for reactions. `aria-label` added to every control.
- **A hairline progress rail** down the left edge of the stage, fed from the existing
  `timeupdate` handler.
- **First accessibility pass**: a global `prefers-reduced-motion` block (there was none), a
  `:focus-visible` ring (there was none, and two inputs set `outline: none`), and a
  reduced-motion path in the canvas engine that draws one composition and starts no rAF at all —
  verified at zero rAF calls.

Fixed in passing:

- `setStatus()` assigned `el.className` outright, wiping any other class on `#videoStatus` /
  `#subStatus`. Now swaps only the state class.
- `#playBtn` had its `textContent` rewritten on every play/pause event, which would have deleted
  its inline SVGs. Now toggles a `.playing` class.
- Dragging a tile in the waiting room had no visible effect but still wrote the junk coordinates
  to `localStorage` on pointerup, quietly overwriting the floating layout arranged during the
  last film. Guarded.

Verified: full create → waiting room → play flow; two windows on one room code, including that a
**guest who never touches the start button** retires its ambient layer correctly (which is the
test that proves the `applyPhase()` hook rather than the button); reduced motion; narrow, tall and
ultrawide viewports; zero console errors throughout. All 98 element ids preserved through the
markup rewrite, checked automatically.

### 2026-07-27 — a room you enter: create/join, a waiting room, and host approval

The entrance is no longer a single form. The app now has a front door, a place to stand around in
before the film, and a way for the host to answer it.

- **Create a room / Join a room** on landing, then a setup card, then a live status card. A
  `?room=` link skips the choice and opens the join form directly — a shared link must never make
  someone pick.
- **"That room doesn't exist."** Joining probes for 12s for any peer and says so if nobody answers,
  with **Try again** and **Back** (which calls `net.leave()`, so an abandoned attempt cannot linger
  as a ghost). With no server, room existence can only mean "somebody is in it right now".
- **A waiting room.** `#stage` gains `.phase-lobby` and shows an overlay with the room code, a copy
  link, the roster, and the host's **▶ Start the movie**. Chat, reactions, cameras and the roster
  are all live in there; playback controls are disabled with a reason on hover. Everyone's tiles
  lay out in a grid so faces are the biggest thing on screen, then return to floating for the film.
- **Knock to enter.** Arriving after the start sends a request to the host, who gets a small corner
  card — *"Carol wants to join"* — with Allow / Not now. Approved arrivals are pulled to the host's
  position. Multiple requests queue.
- **Host controls** in the roster panel: *Let people join after the movie starts* (off means the
  host is never interrupted, the knocker is told the room is closed) and *Who can control playback*
  (Everyone, unchanged default, or Host only — enforced on receive as well as on send).
- **The camera opt-in checkbox is gone.** The camera comes on in the waiting room and 📷/🎙 toggle
  it at any moment, including mid-film. A connection failure within 20s of a camera going on now
  names the camera and offers **Rejoin without video**. See the reversed decision above.
- **Subtitles are genuinely loadable later.** CC with no track goes straight to the file picker
  instead of opening Settings, and a `.srt`/`.vtt` can be dropped anywhere on the video.
- **Click outside a panel to close it.** The control bar is exempt (reaching for the volume slider
  is not a dismissal) and so is each panel's own button, or the dismiss and the toggle cancel out.
  Opening a panel now closes the others instead of stacking them invisibly.
- `startAllBtn` relabelled **Bring everyone to my position**, now that "Start the movie" exists
  separately.
- Three new gotchas recorded, all found during this work.

### 2026-07-27 — video tiles: drag anywhere, mute badge, fade and size

Seven fixes to the tile and overlay layer, all verified in a live two-peer session with synthetic
cameras.

- **Fixed: peer tiles could only be dragged sideways.** Their wrapper `#peerTiles` had no height,
  and the drag code clamped against it — so the vertical clamp collapsed to `0` for every input.
  The wrapper is now a real full-stage layer and drag clamps against `offsetParent`. See the
  gotcha; this pattern will bite again.
- **Fixed: your own tile never showed the speaking outline.** Only incoming streams were analysed.
  The local stream is now watched too, flagged `selfOnly` so it lights your tile without ducking
  your own movie.
- **Mute and camera badges on every tile**, via a new `av` message — a translucent 🔇, and the
  existing camera-off placeholder for a peer who turns their camera off. Sent targeted on join so
  late arrivals see the right state.
- **Subtitles lift clear of the control bar** while it is on screen (12% of video height) and drop
  back when it hides. Cue position is a property of the cues, not something `::cue` can style, so
  it is reapplied on `cuechange` as well.
- **Tile fade and tile size sliders** in Settings, applying to every tile at once via custom
  properties on `#stage`, both persisted. A faded tile returns to full strength while that person
  speaks, while you hover it, and while it is being dragged. A hand-resized tile keeps its own
  width.
- **The subtitles button is now `CC`, not a second 💬.** It was indistinguishable from the chat
  button.
- Peer tile positions persist per seat (arrival order), since peer ids are regenerated each
  session and can never be matched back to a person.

### 2026-07-26 — group rooms: roster, host, and a synchronised start

The app is no longer strictly two-person. A room now holds **up to about six** people (Trystero
builds a full mesh, so cost grows quadratically past that).

- **Roster panel (👥)** listing everyone with a HOST / YOU badge, per-person latency, and an
  OTHER FILE flag when someone's fingerprint differs from yours. The count sits on the button.
  This exists as much for diagnosis as for features — the ghost-window failure was invisible
  precisely because nothing ever showed you *who* was in the room.
- **Host election** — earliest joiner, derived not stored, so it hands over automatically.
- **"Start for everyone"**, host only: pulls the whole room to the host's position and plays.
- **Anyone can pause and seek**, and it applies to everybody.
- **Per-person everything**: chat messages carry the sender's name, peer video tiles are created
  per person and stacked down the right edge, auto-duck watches every incoming stream and dips the
  movie while *anyone* is talking, and a stall holds the room until the **last** person recovers.
- `net.js` now exposes a participant registry (`participants`, `hostId`, `isHost`, `name(id)`)
  instead of a single nominated peer.

Verified with three simultaneous peers: consistent roster and host on all three, synchronised
start (within 0.25s), non-host pause and seek propagating to everyone, chat attributed correctly,
host handover on the host leaving, and dynamic tiles created/labelled/removed cleanly.

### 2026-07-26 — root cause found: both sides were connected to their own stale windows

The new diagnostics paid for themselves on the first run. Both machines reported
`Path: host/host`, `Peers in room: 1`, ~2-5ms latency — and each showed the *other* name than
expected: the Mac said "watching with Tarun" (Tarun's own machine), the PC said "watching with
Apoorv" (Apoorv's own machine). A host/host candidate pair cannot occur across the internet. Each
browser had connected to a leftover Movie Watch window on its own laptop; **the two laptops never
discovered each other at all.** Every earlier theory (renegotiation killing the link, TURN) was
wrong, or at least unproven — there was never a cross-machine connection to break.

- **Pinned the Nostr relay list — then reverted it the same session.** It broke discovery outright
  (both sides stuck on "Connecting…"). The relays were chosen on "the WebSocket opens", which does
  not imply they forward Nostr ephemeral events. See the gotcha; do not retry this without
  two-network discovery testing.
- **Added a `host/host` warning banner** naming the peer, so a local-only connection announces
  itself instead of masquerading as success.
- **Added a "Watching with" diagnostics row** showing the peer's name and your own side by side.
  Seeing your own name in it is the instant tell.
- **Wired `pagehide` alongside `beforeunload`** so windows leave the room more reliably.

### 2026-07-26 — cameras made opt-in so sync and chat survive without TURN

- The first two-machine session (different networks) had both sides showing "Connected" with no
  video and no sync. `onPeerJoin` only fires after a successful data-channel handshake, so the
  connection provably worked at that moment — the most likely killer is the ICE renegotiation
  triggered by adding a camera stream, which has no TURN relay to fall back on.
- **Cameras are now opt-in and off by default** (`#useCamera` in the lobby). Unticked means
  `getUserMedia` is never called: no prompt, no track, no renegotiation. Camera-only controls
  (mic, cam, auto-duck, voice volume) hide themselves rather than sitting there doing nothing.
- **Presence no longer depends on the video tile.** The status line reads
  "Connected — watching with <name>", and the peer's arrival is announced in chat.
- Verified with two peers, cameras off: play/pause/seek sync both directions (drift < 0.1s),
  chat delivered with the right name and movie timestamp, emoji reaction rendered on the peer.

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
