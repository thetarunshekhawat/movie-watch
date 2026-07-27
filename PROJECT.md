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
| HTML/CSS shell | `index.html`, `css/style.css` | ✅ Done |
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

**Which relays are in play is derivable, so measure them instead of guessing.** Trystero picks
five (`redundancy: 5`) from its 47 defaults by seeded shuffle, and the seed is the sum of the
`appId` character codes — deterministic, so every peer in the app lands on the *same* five. For
`movie-watch-p2p-v1` (seed `1655`) they are `social.amanah.eblessing.co`, `nostr.vulpem.com`,
`schnorr.me`, `testnet-relay.samt.st` and `relay-can.zombi.cloudrodion.com`. This kills a whole
class of wrong theory: peers cannot "draw disjoint relay subsets and miss each other", because the
subset is not random per peer. It also means relay health is a five-line check — open each socket,
publish a signed ephemeral event on a `#x` topic, and see whether your own subscription receives
it back. A relay that accepts the socket but never echoes is a dud; a relay that echoes works. Do
that before blaming relays for anything.

**"Peer discovered" and "peer connected" are different events, and only the second one counts.**
`net.peerCount` rises on `room.onPeerJoin`, which Trystero fires once the WebRTC data channel is
open — after signaling, ICE, and DTLS. Nothing in this app observes discovery on its own. So any
code that treats `peerCount === 0` as "the room is empty" is really saying "no fully connected
peer", and will blame the room for what is actually a network-path failure. `joinExisting()` does
exactly this today; see **Known issues**.

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

**TURN is required on this network. It is now configured, but the fix is UNVERIFIED against the
pair that failed.** *(Measured 2026-07-27 — this replaces the previous "no evidence either way"
note.)* A real cross-network attempt failed: the host sat in the waiting room on Chrome/Windows
while the joiner on Safari/macOS got `Room “movie-jt523c” doesn't exist`. The room existed. The two
browsers simply could not build a peer connection, and `joinExisting()` cannot tell those two cases
apart — see the next entry. Evidence gathered from the joining machine:

- **The network hands out a different public IP per flow.** One `RTCPeerConnection`, one local port
  (`61143`), produced *two* srflx candidates at once: `103.114.167.242` and `122.15.199.237`. A
  third, `43.255.222.130`, appeared in UDP probes from the same socket. The machine sits on
  `10.10.40.0/21` behind a shared gateway with many neighbours — an institutional CGNAT with
  several WAN uplinks, load-balanced per flow.
- **NAT filtering is address-and-port-dependent** (RFC 5780 test against `stun.miwifi.com`: replies
  from a different IP *and* from a different port were both dropped).

Together those two are fatal without a relay. The joiner advertises, say,
`122.15.199.237:61143`; the host's connectivity checks arrive at a gateway holding no mapping for
the host and are dropped. The joiner's own checks leave via a *different* WAN IP than the one it
advertised, so they arrive at the host from an unexpected source address and are dropped by the
host's own address-restricted filter. Neither direction ever completes, ICE never succeeds,
`onPeerJoin` never fires. This is precisely the case `TURN` exists for.

`TURN` in `net.js` is **no longer empty** — a Metered Open Relay account (project `movie-watch`,
20GB/month free) went in the same day. What *is* verified: the credentials allocate real relay
candidates from the affected network (`iceTransportPolicy: 'relay'` gathered six, via
`45.79.127.179`), Trystero passes `turnConfig` through to `RTCPeerConnection`, and adding it did not
regress ordinary peering. What is **not** verified: that the original Chrome/Windows ↔ Safari/macOS
pair now connects. Nobody has re-run it. Until someone does and sees `Path: relay/…`, treat this as
a well-founded fix rather than a confirmed one.

One measurement from that network is worth keeping: the **UDP** TURN lookups failed there
(`701 TURN host lookup received error`) and only the **TCP/TLS** entries allocated. All four URLs in
the `TURN` array are load-bearing; trimming it to the plain `turn:…:80` udp entry would restore the
original failure on exactly the network that prompted the fix.

Ruled out while diagnosing, so nobody re-treads it: all five Nostr relays this app derives from its
`appId` were reachable and correctly forwarded ephemeral events (publish → subscribe round trip);
their TLS certificates were all valid; the network is *not* symmetric NAT (port mapping is
preserved); and peer discovery itself is fast — two browsers on one machine reached `onPeerJoin` in
**1.5 s**, so the 12 s probe window has ample headroom and is not the problem.

**"Room doesn't exist" is a misdiagnosis, not a message.** `joinExisting()` in `main.js` waits
`ROOM_PROBE_MS` for `net.peerCount > 0`, and `peerCount` only rises on `room.onPeerJoin` — which
fires after a **fully established WebRTC data channel**, not after discovery. So every transport
failure downstream of discovery — ICE failure, no TURN, a dead relay, a firewall — surfaces to the
user as the confident and wrong claim that nobody is in the room. The two states worth separating
are "no announce ever seen" (really empty) and "found them, could not connect" (a network route
problem). Until they are, this message will keep sending people to check a room code that was
correct all along.

**One Nostr relay throws cert errors.** `wss://schnorr.me/` fails with
`ERR_CERT_AUTHORITY_INVALID` and spams the console. Harmless — Trystero connects through the other
relays — but it makes the console noisy when debugging. *(Checked 2026-07-27: the certificate now
chains to Google Trust Services WE1 and is valid. This may have been fixed upstream; treat a
recurrence as relay-side churn, not as an app problem.)*

Read the Settings (⚙) rows to tell the cases apart:

| Reading | Means |
|---|---|
| `Path: host/host` | Same machine or same LAN. Across the internet this is a ghost window. |
| `Path: srflx/srflx` or `prflx` | Genuine direct connection between the two machines. |
| `Path: relay/…` | Going through a TURN server. |
| `Peers in room: 0` | The two never found each other — signaling or discovery problem. |
| `Connection: failed` | Found each other, but no usable network route. **This** is what TURN fixes. |

---

## Next steps

1. **Re-run the pair that failed, and read the Path row.** TURN is in (`net.js`), and every part of
   it is verified *except* the part that matters: that those two specific machines now connect.
   Same two people, same two networks, same room. `Path: relay/…` in Settings (⚙) is the proof.
   Anything else — still "Room doesn't exist", or `Peers in room: 0` — means the relay is not being
   selected, and the next thing to check is whether the movie file gate is stopping the joiner
   before `connect()` ever runs. **Do this before building anything else.**
2. **Stop reporting connection failure as "Room doesn't exist".** `joinExisting()` should
   distinguish "no announce ever seen" from "found them, could not connect". The cheapest honest
   split: keep waiting for `net.peerCount`, but if `room.getPeers()` has entries whose
   `connectionState` is `connecting`/`failed`, say so — the room was found, the network route was
   not — and point at TURN rather than at the room code.
3. **Verify the camera on two real machines** now that TURN is in — more urgent than it was, since
   the camera is no longer opt-in and every session renegotiates. If it turns out to break
   cross-network links routinely, the fix is not to bring the checkbox back but to negotiate the
   media transceivers up front (a silent placeholder stream at join, swapped for the real tracks
   with Trystero's `replaceTrack`), which avoids renegotiation entirely.
4. **Try the waiting room with real people.** It has only ever been driven by a script. The open
   questions are whether 12s feels too long to wait on the "looking for room" card, and whether a
   host watching a film actually notices the corner join-request card.
5. **Check `SPEAK_THRESHOLD` (0.045) against a real microphone.** Every speaking-indicator test so
   far has used an oscillator at a fixed level, which says nothing about whether a normal speaking
   voice crosses the line — or whether movie audio bleeding into the mic crosses it constantly.
6. Optional: `showOpenFilePicker()` + IndexedDB to remember the file and resume position between
   sessions, so the movie doesn't have to be re-picked every time.

*Dropped from this list: "re-test with every window closed to rule out ghost peers" and "add TURN
**if** the machines still fail". Both are answered — the cross-network attempt was real, not a
ghost, and it failed. Relay selection is also settled: the five relays this `appId` derives were
each verified to forward ephemeral events, so reordering or pinning them fixes nothing.*

---

## Changelog

*Newest first.*

### 2026-07-27 — TURN goes in

`TURN` in `net.js` is no longer empty: a Metered Open Relay account (project `movie-watch`, 20GB
per month free) now backs the ICE config, closing the failure diagnosed earlier the same day.

Verified before wiring it in: the credentials allocate six real `relay` candidates from the network
that failed (via `45.79.127.179`, forced with `iceTransportPolicy: 'relay'`); Trystero 0.25.3 does
honour `turnConfig` (`core.js` builds `iceServers: Dt.concat(f ?? [])`, so it reaches
`RTCPeerConnection` rather than being silently dropped); and two peers on one machine still reach
`onPeerJoin` in 2.3s afterwards, with the live connection reporting 5 iceServers including the
Metered entry. **Not** verified: that the original Chrome/Windows ↔ Safari/macOS pair now connects.
That is **Next steps** item 1 and it needs two real people.

Two things learned in the process, both now in the code comment:

- **The real hostname is `global.relay.metered.ca`**, nothing like the `<subdomain>.metered.live`
  placeholder the old comment carried. Metered changes these. The comment now points at the
  credentials REST endpoint as the source of truth instead of naming hosts that go stale.
- **UDP TURN lookups fail on the affected network** (`701 TURN host lookup received error`); only
  the TCP and TLS entries allocated. All four URLs are load-bearing. Trimming the array to the
  plain udp entry would restore the exact failure this fixes.

Also corrected: the free tier is 20GB/month, not the "50GB, no card" this file claimed. The
credentials are public — a static site has no backend to hide them behind — so the quota is
burnable and rotation is a dashboard click.

### 2026-07-27 — the cross-network answer: TURN is required, and its absence lies about the room

A real attempt between two machines on different networks failed: the host sat in the waiting room
on Chrome/Windows while the joiner on Safari/macOS was told `Room “movie-jt523c” doesn't exist`.
The room existed. This is the first genuine cross-network attempt on record — every previous one
turned out to be a browser talking to a ghost window on its own laptop — so it finally settles the
question the last three entries left open.

**What it is.** The joining network hands out a *different public IP per flow*: one
`RTCPeerConnection` on one local port produced srflx candidates for both `103.114.167.242` and
`122.15.199.237`, and a third address appeared on the same socket in UDP probes. Filtering is
address-and-port-dependent (RFC 5780 test: replies from a different IP, and from a different port,
were both dropped). A peer therefore cannot reach the address the joiner advertises, and the
joiner's own checks arrive from an address the peer never expected. ICE cannot close that loop
without a relay, and `TURN` in `net.js` was empty at the time of this measurement. *(Fixed later
the same day — see the entry above.)*

**What it is not.** Ruled out, so nobody re-treads them: the five Nostr relays this `appId` derives
were each verified to forward ephemeral events end to end; their TLS certificates are all valid
(`schnorr.me` included — its cert error appears to have been fixed upstream); the NAT is not
symmetric; and discovery is fast — two browsers on one machine reached `onPeerJoin` in 1.5s, so the
12s probe window is not the constraint.

**The second bug, which hid the first.** `joinExisting()` waits for `net.peerCount > 0`, and
`peerCount` only moves on `room.onPeerJoin` — which fires after a *fully established* data channel.
Discovery succeeding and the connection failing is indistinguishable, at that call site, from
nobody being there. So a network-route failure is reported as a confidently wrong claim about the
room code, sending people to re-check something that was correct. Recorded in **Known issues**;
the fix is **Next steps** item 2.

No code changed in this entry — it is a measurement. **Next steps** are re-ordered around it:
adding TURN is now the blocker rather than a contingency.

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
