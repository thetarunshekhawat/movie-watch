# Instructions for Claude

## Read PROJECT.md first

`PROJECT.md` is the source of truth for this project. Read it before doing anything else — it
contains the architecture, the reasoning behind every settled decision, the exact message protocol,
and a list of gotchas that each cost real debugging time.

Pay particular attention to **Gotchas & learnings** before touching `js/sync.js`, fullscreen code,
or keyboard handling. Those three areas have non-obvious failure modes that are already documented.

## Keep PROJECT.md current

After any meaningful change — a feature completed, a bug fixed, an architectural decision made, a
new gotcha discovered — update `PROJECT.md` **in the same turn as the change**, not at the end of
the session. Deferred updates get lost.

What to update:

| When | Update |
|---|---|
| A component starts or finishes | **Current status** table |
| A design choice is made or reversed | **Decision log** — always include *why* |
| A message payload changes | **Message protocol** table |
| A non-obvious failure mode is hit | **Gotchas & learnings** |
| A bug is found but not fixed | **Known issues**, with repro steps |
| Any of the above | Prepend a dated entry to **Changelog** |

Also refresh **Next steps** so the list always reflects what genuinely comes next.

**Never let `PROJECT.md` disagree with the code.** If it does, the code wins — fix the doc. A stale
doc is worse than no doc, because it will be trusted.

## Project conventions

- **Vanilla JS ES modules. No build step, no npm, no bundler.** Do not introduce one.
- External deps load from a CDN via `<script type="module">` — currently only Trystero from
  `https://esm.run/trystero`.
- The movie file is **never** uploaded or streamed. It is read locally via `URL.createObjectURL`.
  Any change that sends video data over the network is wrong.
- Volume and subtitles are **per-person by design**. Do not sync them.
- Test with two browser windows (one normal, one incognito) on the same room code before claiming
  anything works. The verification checklist is in the plan file and mirrored in `README.md`.
