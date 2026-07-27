#!/usr/bin/env bash
# Extract stills from your own copy of a film.
#
# This is the better-looking of the two routes, because you choose the exact
# moment rather than accepting whatever the studio put in a press kit — and the
# frames never leave your machine.
#
#   tools/grab-frames.sh <video-file> <slug> <timestamp> [timestamp ...]
#
# Example:
#   tools/grab-frames.sh ~/films/Interstellar.mkv interstellar \
#       00:52:14 01:32:07 02:12:40 02:41:55
#
# Writes img/frames/<slug>-1.jpg … -N.jpg, which is exactly where the manifest
# in js/frames-data.js expects them. Use the same slug as the manifest entry.
#
# Timestamps are HH:MM:SS. To find them, scrub the film in any player and note
# the moments you want; -ss before -i seeks fast, and one frame costs nothing.

set -euo pipefail

if [ "$#" -lt 3 ]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

VIDEO="$1"; SLUG="$2"; shift 2
OUT="$(cd "$(dirname "$0")/.." && pwd)/img/frames"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. brew install ffmpeg" >&2
  exit 1
fi
[ -f "$VIDEO" ] || { echo "No such file: $VIDEO" >&2; exit 1; }

mkdir -p "$OUT"

i=1
for ts in "$@"; do
  dest="$OUT/${SLUG}-${i}.jpg"
  # -ss before -i: keyframe seek, near-instant even on a 4K remux.
  # 1600px wide is plenty — the stack never draws a frame larger than about a
  # third of the viewport, and everything is mipmapped at load anyway.
  ffmpeg -loglevel error -y -ss "$ts" -i "$VIDEO" -frames:v 1 \
         -vf "scale=1600:-2" -q:v 3 "$dest"
  echo "  $ts  ->  img/frames/${SLUG}-${i}.jpg"
  i=$((i + 1))
done

echo "Done. ${SLUG}: $(( i - 1 )) still(s)."
