# 🍿 Movie Watch

Watch a movie with your friends, from anywhere, in perfect sync. Up to about six people per room.

Everyone plays **their own copy** of the film from their own hard drive. Nothing is uploaded or
streamed — only tiny "play"/"pause"/"seek" messages travel between you. So the video is always
full quality, and it works even on slow internet.

- Anyone pauses, it pauses for everyone
- A roster (👥) showing exactly who's in the room, and who's hosting
- The host's **Start for everyone** pulls the whole room to the same moment
- Chat and emoji reactions over the movie, without pausing it
- **Volume and subtitles are yours alone** — set them however you like
- Optional webcams, with the movie ducking when the other person talks

> **Cameras are off by default, and that's deliberate.** Sending video renegotiates the
> connection, and without a TURN relay that can break an otherwise healthy link — taking sync and
> chat down with it. Tick **Turn on camera and mic** in the lobby only if you're both on the same
> wifi. Otherwise leave it off and put a normal video call on your phone alongside.

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

1. Everyone opens the link
2. Type the **same room code** (or just use the `?room=...` link the app generates)
3. Pick your movie file — and a subtitle file if you want one
4. Hit **Join room**
5. Open the roster (👥) and check everyone you expect is listed
6. The **host** — whoever joined first — presses **Start for everyone**

After that anyone can pause, seek or skip, and it applies to the whole room.

**If you turn cameras on, wear headphones.** This is not optional. Without them, the movie's audio
comes out of your speakers, goes into your microphone, and echoes back to the other person. Browser
echo-cancellation is built for voices, not loud continuous film audio, and it will not save you.
(With cameras off — the default — there's no microphone, so this doesn't apply.)

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

**Someone's missing from the roster (👥).**
The roster is the truth about who is actually connected. If a name isn't there, that person hasn't
joined — check the room code matches exactly. If you see **your own name twice**, you have a stale
Movie Watch window open somewhere; quit the browser entirely and rejoin.

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
Cameras are off by default. Tick **Turn on camera and mic** in the lobby — on both sides. If it's
ticked and you still can't see each other, you're almost certainly on different networks: there's
no TURN relay configured, so there's no route for the video. Open Settings (⚙) and read **Path** —
`host` means same machine, `srflx`/`prflx` means direct, `relay` means TURN. Leave cameras off and
use a phone call instead; sync and chat don't need any of this.

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
