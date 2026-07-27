# 🍿 Movie Watch

Watch a movie with your friends, from anywhere, in perfect sync. Up to about six people per room.

Everyone plays **their own copy** of the film from their own hard drive. Nothing is uploaded or
streamed — only tiny "play"/"pause"/"seek" messages travel between you. So the video is always
full quality, and it works even on slow internet.

- **Create a room** or **join** one with a code — joining a room nobody's in tells you so
- A **waiting room** where everyone gathers, chats and sees each other before the film starts
- Anyone pauses, it pauses for everyone
- A roster (👥) showing exactly who's in the room, and who's hosting
- Arrive after the movie started? You **ask to join**, and the host gets a prompt
- Host controls: allow or refuse late arrivals, and restrict playback to yourself
- Chat and emoji reactions over the movie, without pausing it
- **Volume and subtitles are yours alone** — load subtitles at any point, even mid-film
- Webcams that go on and off whenever you like, with the movie ducking when someone talks

> **A note on cameras.** Your camera comes on in the waiting room, and 📷 toggles it at any time.
> Turning a camera on renegotiates the peer connection, and with no TURN relay configured that can
> break a link that was working — which is why it happens in the waiting room, while people are
> still saying hello, rather than an hour into the film. If the connection drops right after,
> the app says so and offers to rejoin without video.

There is **no server**. Just a web page.

---

## Setup, once

### 1. Prepare the movie file

Do this before anything else, and **send the converted file to the other person** so you both have
exactly the same one.

Browsers are picky. The usual dealbreaker is the audio: movie downloads very often use **AC3** or
**DTS** audio, which no browser can decode. You'd get perfect video and total silence.

```bash
# See what you've actually got
ffprobe -v error -show_entries stream=index,codec_type,codec_name -of csv movie.mkv

# The fix — takes seconds, loses no quality.
# Copies the video untouched, converts only the audio.
ffmpeg -i movie.mkv -c:v copy -c:a aac -b:a 192k -movflags +faststart movie.mp4
```

If the video itself won't play (usually HEVC/x265 on a PC without hardware support), you have to
re-encode. **This takes hours**, so only do it if the command above wasn't enough:

```bash
ffmpeg -i movie.mkv -c:v libx264 -crf 20 -preset fast -c:a aac -b:a 192k -movflags +faststart movie.mp4
```

Subtitles baked into an `.mkv` are lost when you convert. Pull them out first:

```bash
ffmpeg -i movie.mkv -map 0:s:0 movie.srt
```

> Don't have ffmpeg? `brew install ffmpeg` on Mac, `winget install ffmpeg` on Windows.

**You don't have to guess at any of this.** Load the file in the app and it will tell you exactly
what's wrong and give you the command to fix it.

### 2. Put the page online

`getUserMedia` (the camera) only works over HTTPS, so the page has to be hosted. GitHub Pages is
free and permanent:

1. Create a GitHub repo and push these files to it
2. Settings → Pages → deploy from `main`, folder `/ (root)`
3. You get `https://<you>.github.io/movie-watch/`

Send that link to the other person once. It never expires, so they can bookmark it.

---

## Movie night

1. One person opens the link and picks **Create a room**. Pick your movie file, hit **Create room**.
2. Press **Copy link** in the waiting room and send it to everyone else.
3. Everyone else opens that link — it goes straight to **Join a room** with the code filled in — picks
   their own copy of the movie, and hits **Join room**.
4. You're all in the **waiting room**. Chat, wave at each other, sort out who's still getting snacks.
5. Check the roster: everyone you expect should be listed, with one **HOST**.
6. The host presses **▶ Start the movie**. Everyone starts at the same moment.

After that anyone can pause, seek or skip, and it applies to the whole room.

**Turning up late.** If you join after the film has started, you'll see *"the movie has already
started"* and your request goes to the host, who gets a prompt and can let you in. You land at
exactly where everyone else is. The host can switch that off entirely in the roster panel under
**Host controls**, along with restricting play/pause/seek to themselves.

**Forgot your subtitles?** Press **CC** at any point, or drag a `.srt` onto the video. They're
yours alone either way.

**Wear headphones.** This is not optional once anyone's mic is on. Without them, the movie's audio
comes out of your speakers, goes into your microphone, and echoes back to everyone else. Browser
echo-cancellation is built for voices, not loud continuous film audio, and it will not save you.

### Controls

| Key | Does |
|---|---|
| `Space` | Play / pause — **synced** |
| `←` `→` | Back / forward 5s — **synced** |
| `↑` `↓` | Volume — just you |
| `F` | Fullscreen |
| `C` | Subtitles on/off — just you |
| `M` | Mute your mic |
| `T` | Hold to talk (while muted) |
| `Esc` | Close panels |

Anything with a 🔗 on it affects both of you. Anything labelled **"just you"** doesn't.

---

## When something's wrong

**"Room X doesn't exist" — but I know it does.**
Believe yourself, not the message. It means "no fully connected peer within 12 seconds", and it
cannot tell an empty room apart from one it found but couldn't reach. In that order:

1. A room only exists while somebody is sitting in it. If the host closed their window, the room is
   gone — ask them to open it again. And check the code character for character.
2. If they're definitely there, press **Try again** once, in case it was a slow relay handshake.
3. If it fails again, it is almost certainly the network, not the room. Some networks — university
   and office wifi especially, and mobile hotspots — will not allow two browsers to connect
   directly, and this app has no relay server configured to fall back on. The tell is the Settings
   (⚙) panel: **Peers in room: 0** with the connection never reaching `srflx` or `prflx`. Try both
   people on ordinary home wifi. See "Add a TURN server" in `PROJECT.md` for the real fix.

**"Your request to join has been sent" and nothing happens.**
The host is watching a film and may not have noticed the prompt. Press **Ask again**, or message
them. If they've turned off late joining you'll be told outright instead of left waiting.

**Someone's missing from the roster (👥).**
The roster is the truth about who is actually connected. If a name isn't there, that person hasn't
joined — check the room code matches exactly. If you see **your own name twice**, you have a stale
Movie Watch window open somewhere; quit the browser entirely and rejoin.

**The play button is greyed out.**
Either the movie hasn't started yet (you're in the waiting room — the host starts it), or the host
has set **Who can control playback** to *Host only*. Hover the button and it tells you which.

**"It says connecting forever."**
You're probably not in the same room code — check for typos, or just use the same link. If the code
matches, one of you may be on a network that blocks peer-to-peer connections (office wifi, some
university networks, strict VPNs). Try a phone hotspot to confirm.

**The movie won't load.**
Codec problem. The app shows the exact `ffmpeg` command — copy, paste, run, use the new file. Make
sure you *both* switch to the converted file.

**The movie plays but there's no sound.**
AC3 or DTS audio. The app warns about this when you pick the file. Run the first `ffmpeg` command
above.

**"You two have different files."**
Your copies aren't identical, so timestamps don't line up. Best fix is to share one file. If you
can't, open Settings (⚙) and use **Sync offset** to nudge yours until you match. It's remembered
for that room.

**We're drifting apart.**
It self-corrects within a few seconds — the app quietly speeds up or slows down the follower by up
to 10%. If it's badly out, hit **Force resync now** in Settings.

**She can hear the movie twice / there's an echo.**
Headphones. See above.

**You can't see each other.**
Press 📷 on both sides and check the browser actually granted access. If the cameras are on and you
still can't see each other, you're almost certainly on different networks: there's no TURN relay
configured, so there's no route for the video. Open Settings (⚙) and read **Path** — `host` means
same machine, `srflx`/`prflx` means direct, `relay` means TURN. Turn the cameras off and use a phone
call instead; sync and chat don't need any of this.

**Everything died the moment a camera came on.**
That's the renegotiation. The app spots this and offers **Rejoin without video** — take it. Video
between two networks needs a TURN relay, which isn't configured.

**"Connected" but nothing syncs — check this first.**
Open Settings (⚙) and read **Path** and **Watching with**.

- **Path says `host/host`** and the other person is on a different computer → you are connected to
  a leftover Movie Watch window on *your own* machine. It looks completely healthy — green dot,
  low latency, a name — and it is talking to itself. **Quit your browser entirely** (not just the
  tab) on both machines and start again.
- **Watching with shows your own name** → same thing, confirmed.
- **Peers in room: 0** → you never found each other. Check you both typed the exact same room code.
- **Connection: failed** → you found each other but there's no network route between you. That
  needs a TURN server, which isn't configured yet.

---

## Testing changes

You don't need a second person. Open the page in a **normal window and an incognito window** with
the same room code — they're genuinely separate peers, so the whole sync loop works. Use a short
clip, not a two-hour film.

A test clip with a burned-in timecode makes desync obvious at a glance:

```bash
ffmpeg -f lavfi -i "testsrc=size=640x360:rate=25:duration=60" \
  -f lavfi -i "sine=frequency=440:duration=60" \
  -vf "drawtext=text='%{pts\:hms}':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:x=20:y=20" \
  -c:v libx264 -crf 28 -c:a aac -movflags +faststart testclip.mp4
```

Run locally with any static server (`localhost` counts as secure, so the camera works):

```bash
python3 -m http.server 8000
```

---

## How it works

```
   YOUR BROWSER                                      THEIR BROWSER
   ┌──────────────────────────┐                      ┌──────────────────────────┐
   │ <video> ← your local file│                      │ <video> ← their local file│
   │ volume/subs: yours       │                      │ volume/subs: theirs      │
   └──────────────────────────┘                      └──────────────────────────┘
              │                                                 │
              └────────── WebRTC, peer-to-peer ─────────────────┘
                    • play / pause / seek / heartbeat / chat
                    • webcam + mic
                          ▲
                          │ one-time introduction only
                    public Nostr relays (via Trystero)
```

[Trystero](https://github.com/dmotz/trystero) introduces the two browsers to each other over public
relays, so there's no signaling server to run or pay for. Once you're connected, the relays are out
of the picture and the session keeps working even if they go down.

Vanilla JavaScript, no build step, no npm. The only dependency loads from a CDN.

**Architecture, decisions, and hard-won gotchas live in [`PROJECT.md`](PROJECT.md).** Read it before
changing anything in `js/sync.js`.

---

## Prior art

If this ever gives you trouble, [Syncplay](https://syncplay.pl/) + VLC does the synchronised
playback part very well and handles any file format — it just can't put your faces on the screen,
and you both have to install and configure it.
