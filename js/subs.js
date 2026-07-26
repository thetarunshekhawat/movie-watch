/**
 * subs.js — subtitles, strictly per-person.
 *
 * Nothing here is ever synced: each side loads their own file and styles it their
 * own way. That's a design requirement, not an oversight.
 *
 * <track> only accepts WebVTT, so SRT is converted in the browser.
 */

/**
 * Convert SRT to WebVTT.
 *
 * The differences that matter in practice are the header, the comma decimal
 * separator in timestamps, and stray cue numbers. This handles all three plus the
 * BOM that Windows-authored SRT files often carry.
 */
export function srtToVtt(text) {
  let out = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // 00:01:02,500 --> 00:01:05,000   becomes   00:01:02.500 --> 00:01:05.000
  out = out.replace(
    /(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g,
    (_, time, ms) => `${time}.${ms.padEnd(3, '0')}`
  );

  // Some SRT files use 2-digit hours only sometimes; VTT needs consistency,
  // but browsers accept mm:ss.mmm too, so we only pad when hours are missing.
  out = out.replace(
    /^(\d{1,2}:\d{2}\.\d{3}) --> (\d{1,2}:\d{2}\.\d{3})/gm,
    (_, a, b) => `00:${a} --> 00:${b}`
  );

  return 'WEBVTT\n\n' + out.trim() + '\n';
}

/**
 * Load a subtitle file onto the video as the sole active track.
 * Returns the TextTrack, or null if the file was unusable.
 */
export async function loadSubtitles(video, file) {
  clearSubtitles(video);

  const raw = await file.text();
  const isVtt = /^﻿?WEBVTT/.test(raw) || file.name.toLowerCase().endsWith('.vtt');
  const vtt = isVtt ? raw.replace(/^﻿/, '') : srtToVtt(raw);

  const blob = new Blob([vtt], { type: 'text/vtt' });
  const url = URL.createObjectURL(blob);

  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = file.name.replace(/\.[^.]+$/, '');
  track.srclang = 'en';
  track.src = url;
  track.default = true;
  track.dataset.objectUrl = url;
  video.appendChild(track);

  // The track element needs a tick before video.textTracks reflects it.
  await new Promise(r => setTimeout(r, 0));
  const tt = video.textTracks[video.textTracks.length - 1];
  if (tt) tt.mode = 'showing';
  return tt || null;
}

export function clearSubtitles(video) {
  video.querySelectorAll('track').forEach(t => {
    if (t.dataset.objectUrl) URL.revokeObjectURL(t.dataset.objectUrl);
    t.remove();
  });
}

/** Show/hide without unloading. Returns the new visibility. */
export function toggleSubtitles(video) {
  const tt = video.textTracks[0];
  if (!tt) return false;
  tt.mode = tt.mode === 'showing' ? 'hidden' : 'showing';
  return tt.mode === 'showing';
}

export function hasSubtitles(video) {
  return video.textTracks.length > 0;
}

/**
 * Appearance controls.
 *
 * Size and background go through CSS custom properties consumed by ::cue in
 * style.css. Vertical position can't be done in ::cue — it lives on the cue
 * objects themselves, so it has to be reapplied whenever cues load.
 */
export function styleSubtitles(video, { size, bg, pos }) {
  if (size != null) video.style.setProperty('--sub-size', size);
  if (bg != null) video.style.setProperty('--sub-bg', bg);

  if (pos != null) {
    const tt = video.textTracks[0];
    if (tt?.cues) {
      for (const cue of tt.cues) {
        cue.snapToLines = false;
        cue.line = 100 - pos;   // percentage from the top
      }
    }
  }
}
