#!/usr/bin/env node
/**
 * Populate img/frames/ from TMDB.
 *
 * TMDB licenses film stills for exactly this purpose, which is why this route
 * exists rather than scraping image search results. Their terms require the
 * attribution line that ships in README.md — leave it there.
 *
 *   TMDB_API_KEY=xxxx node tools/fetch-stills.mjs            # download files
 *   TMDB_API_KEY=xxxx node tools/fetch-stills.mjs --urls     # no files; rewrite
 *                                                            # the manifest to
 *                                                            # point at the CDN
 *   ... --only interstellar,joker    # just these slugs
 *   ... --width w1280                # w780 | w1280 | original
 *
 * Zero npm dependencies: Node 18+ has fetch and fs/promises built in. This is
 * a one-off tool you run by hand, not a build step — the app itself still has
 * no toolchain.
 *
 * Get a free key at https://www.themoviedb.org/settings/api (no card needed).
 */

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'img/frames');
const KEY = process.env.TMDB_API_KEY;

const args = process.argv.slice(2);
const has = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const URLS_ONLY = has('--urls');
const WIDTH = val('--width', 'w1280');
const ONLY = (val('--only', '') || '').split(',').filter(Boolean);

if (!KEY) {
  console.error('Set TMDB_API_KEY first. Free, no card:');
  console.error('  https://www.themoviedb.org/settings/api');
  process.exit(1);
}

const api = async (path, params = {}) => {
  const u = new URL('https://api.themoviedb.org/3' + path);
  u.searchParams.set('api_key', KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`TMDB ${r.status} on ${path}`);
  return r.json();
};

/** Pull the FILMS array out of the manifest without importing the DOM-y module. */
async function loadFilms() {
  const src = await readFile(resolve(ROOT, 'js/frames-data.js'), 'utf8');
  const body = src.slice(src.indexOf('const FILMS = ['), src.indexOf('];', src.indexOf('const FILMS = [')) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return FILMS;`)();
}

async function findMovie(film) {
  const q = await api('/search/movie', { query: film.title, year: film.year });
  if (q.results?.length) return q.results[0];
  // Retry without the year — re-releases and animation specials drift.
  const q2 = await api('/search/movie', { query: film.title });
  return q2.results?.[0] || null;
}

/** Landscape backdrops, widest first, language-neutral ones preferred. */
async function pickBackdrops(id, n) {
  const imgs = await api(`/movie/${id}/images`, { include_image_language: 'null,en' });
  return (imgs.backdrops || [])
    .filter(b => b.width >= 1280 && b.aspect_ratio >= 1.6)
    .sort((a, b) => (b.vote_average - a.vote_average) || (b.width - a.width))
    .slice(0, n);
}

async function exists(p) { try { await access(p); return true; } catch { return false; } }

const films = (await loadFilms()).filter(f => !ONLY.length || ONLY.includes(f.slug));
await mkdir(OUT_DIR, { recursive: true });

let got = 0, missed = 0;
const urlMap = {};

for (const film of films) {
  process.stdout.write(`${film.title} … `);
  try {
    const movie = await findMovie(film);
    if (!movie) { console.log('not found on TMDB'); missed += film.stills; continue; }

    const picks = await pickBackdrops(movie.id, film.stills);
    if (!picks.length) { console.log('no usable backdrops'); missed += film.stills; continue; }

    const urls = picks.map(p => `https://image.tmdb.org/t/p/${WIDTH}${p.file_path}`);
    urlMap[film.slug] = urls;

    if (URLS_ONLY) {
      console.log(`${urls.length} url(s)`);
      got += urls.length;
    } else {
      let n = 0;
      for (const [i, url] of urls.entries()) {
        const dest = resolve(OUT_DIR, `${film.slug}-${i + 1}.jpg`);
        if (await exists(dest)) { n++; continue; }
        const r = await fetch(url);
        if (!r.ok) continue;
        await writeFile(dest, Buffer.from(await r.arrayBuffer()));
        n++;
      }
      console.log(`${n}/${film.stills} still(s)`);
      got += n;
      missed += film.stills - n;
    }
  } catch (e) {
    console.log(`failed — ${e.message}`);
    missed += film.stills;
  }
}

if (URLS_ONLY) {
  // Emit a module the app imports directly, so re-running this is the whole
  // update step. URLs are not copyrighted content — this points at TMDB's CDN
  // rather than storing anything, which is what their API is for.
  const body = Object.entries(urlMap)
    .map(([slug, urls]) => `  '${slug}': [\n${urls.map(u => `    '${u}',`).join('\n')}\n  ],`)
    .join('\n');
  await writeFile(resolve(ROOT, 'js/frames-urls.js'),
`/**
 * GENERATED by tools/fetch-stills.mjs --urls — do not edit by hand.
 *
 * Still URLs on TMDB's CDN, keyed by the slug in js/frames-data.js. Nothing is
 * stored in this repository; these point at TMDB, which licenses stills for
 * this use and requires the attribution line in README.md.
 *
 * Regenerate:  TMDB_API_KEY=... node tools/fetch-stills.mjs --urls
 */

export const STILL_URLS = {
${body}
};
`);
  console.log('\nWrote js/frames-urls.js — the app picks it up with no further edits.');
}

console.log(`\nDone. ${got} still(s) in place, ${missed} still missing.`);
console.log('Missing entries draw as numbered slates — the app runs fine either way.');
