/**
 * player.js — local file loading, codec preflight, and file fingerprinting.
 *
 * The movie is read from disk with URL.createObjectURL and never leaves the machine.
 * Two safeguards run before playback:
 *
 *   • CODEC PREFLIGHT — browsers can't play .mkv/.avi or AC3/DTS audio. Rather than
 *     showing a black screen, we detect it and hand back the exact ffmpeg command.
 *   • FINGERPRINT — hashes the head and tail of the file so a mismatch is caught in
 *     the lobby instead of twenty minutes into the film.
 */

/** Bytes hashed from each end of the file. Enough to distinguish rips, cheap to read. */
const CHUNK = 1024 * 1024;

/**
 * Identify a file well enough to tell two rips apart, without reading gigabytes.
 * Size alone would false-positive on re-encodes of identical length; head+tail
 * catches different encoders, and reading only 2MB keeps it instant.
 */
export async function fingerprint(file) {
  const head = file.slice(0, CHUNK);
  const tail = file.slice(Math.max(0, file.size - CHUNK));
  const buf = await new Blob([head, tail]).arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `${file.size}-${hex.slice(0, 24)}`;
}

/**
 * Try to actually decode the file, rather than trusting canPlayType (which is
 * famously vague — it returns "maybe" for things that don't work).
 *
 * Checks video AND audio separately, because they fail independently. A file can
 * have perfectly playable video and completely undecodable audio (AC3 and DTS are
 * the usual culprits, and they are extremely common in movie rips). Checking only
 * videoWidth lets those through, and you don't find out until the movie starts and
 * there is no sound.
 *
 * The audio check works by playing muted for a moment and reading
 * webkitAudioDecodedByteCount: it stays at 0 when the codec is unsupported.
 * Verified against an AC3 file — video decoded 43KB while audio decoded 0 bytes.
 *
 * Resolves {ok, duration, hasVideo, audioWarning, reason, fix}.
 */
export function preflight(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'auto';
    probe.muted = true;
    probe.playsInline = true;

    const done = result => {
      clearTimeout(timer);
      probe.pause();
      probe.removeAttribute('src');
      probe.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    // A container the browser refuses outright never fires any event at all,
    // so a timeout is the only way to catch it.
    const timer = setTimeout(() => done({
      ok: false,
      reason: `The browser can't read "${file.name}".`,
      fix: remuxCommand(file.name),
    }), 12000);

    probe.addEventListener('loadedmetadata', async () => {
      if (probe.videoWidth === 0) {
        done({
          ok: false,
          reason: 'The video track uses a codec this browser can\'t decode (usually HEVC/x265).',
          fix: transcodeCommand(file.name),
        });
        return;
      }

      const duration = probe.duration;

      // Decode a few frames muted to see whether the audio track is real.
      let audioWarning = null;
      try {
        await probe.play();
        await new Promise(r => setTimeout(r, 700));
        probe.pause();
        if (probe.webkitAudioDecodedByteCount === 0 && probe.webkitVideoDecodedByteCount > 0) {
          // Either an unsupported audio codec or a genuinely silent file. We can't
          // tell which, so warn rather than block — rejecting a silent file outright
          // would be worse than letting a silent movie through with a heads-up.
          audioWarning = {
            reason: 'No audio could be decoded. If this movie should have sound, its audio '
                  + 'codec (usually AC3 or DTS) isn\'t supported by browsers.',
            fix: remuxCommand(file.name),
          };
        }
      } catch {
        /* autoplay blocked — skip the audio check rather than fail the whole file */
      }

      done({ ok: true, duration, hasVideo: true, audioWarning });
    }, { once: true });

    probe.addEventListener('error', () => {
      done({
        ok: false,
        reason: `"${file.name}" uses a container or codec the browser can't play.`,
        fix: remuxCommand(file.name),
      });
    }, { once: true });

    probe.src = url;
  });
}

/** Fast, lossless path: keep the video stream, convert only the audio. */
export function remuxCommand(name) {
  const out = name.replace(/\.[^.]+$/, '') + '.mp4';
  return `ffmpeg -i "${name}" -c:v copy -c:a aac -b:a 192k -movflags +faststart "${out}"`;
}

/** Slow fallback for video codecs the browser genuinely can't decode. */
export function transcodeCommand(name) {
  const out = name.replace(/\.[^.]+$/, '') + '-web.mp4';
  return `ffmpeg -i "${name}" -c:v libx264 -crf 20 -preset fast -c:a aac -b:a 192k -movflags +faststart "${out}"`;
}

/** Attach a verified file to the real <video> element. */
export function attach(video, file) {
  if (video.dataset.objectUrl) URL.revokeObjectURL(video.dataset.objectUrl);
  const url = URL.createObjectURL(file);
  video.dataset.objectUrl = url;
  video.src = url;
  video.load();
  return url;
}

export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${String(s).padStart(2, '0')}`
           : `${mm}:${String(s).padStart(2, '0')}`;
}
