/**
 * The films shown in the ambient corner stack.
 *
 * This file is a MANIFEST, not an image store. It lists the films and how many
 * stills each should contribute; the images themselves live in `img/frames/`
 * and are never committed to this repository (see `.gitignore`).
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  GETTING THE IMAGES
 *
 *  Two supported routes, both documented in README.md:
 *
 *  A) From your own copies of the films — the better-looking option, because
 *     you choose the exact moment:
 *         tools/grab-frames.sh "/path/to/Interstellar.mkv" interstellar 01:32:10 02:41:55 ...
 *
 *  B) From TMDB, which licenses stills for exactly this use:
 *         TMDB_API_KEY=... node tools/fetch-stills.mjs
 *     Downloads to img/frames/ by default; `--urls` instead rewrites this file
 *     to point at TMDB's CDN so nothing is stored locally at all.
 *
 *  Either way the files land at `img/frames/<slug>-1.jpg … -5.jpg`, which is
 *  exactly what `src` below expects. Nothing else needs editing.
 *
 *  An entry whose file is missing draws as a numbered slate with crop marks
 *  and the film's title — a designed placeholder, not a broken image — so a
 *  half-populated set is perfectly fine to run.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *  `stills` is how many frames that film contributes. Pick the peak moments:
 *  the shot someone who has seen the film would recognise instantly, and that
 *  someone who has not would still find arresting.
 */

const FILMS = [
  { title: 'The Shawshank Redemption',        year: 1994, director: 'Frank Darabont',      slug: 'shawshank-redemption',  stills: 4 },
  { title: '12 Angry Men',                    year: 1957, director: 'Sidney Lumet',        slug: '12-angry-men',          stills: 4 },
  { title: "Schindler's List",                year: 1993, director: 'Steven Spielberg',    slug: 'schindlers-list',       stills: 4 },
  { title: 'Pulp Fiction',                    year: 1994, director: 'Quentin Tarantino',   slug: 'pulp-fiction',          stills: 4 },
  { title: 'Fight Club',                      year: 1999, director: 'David Fincher',       slug: 'fight-club',            stills: 4 },
  { title: 'Inception',                       year: 2010, director: 'Christopher Nolan',   slug: 'inception',             stills: 5 },
  { title: 'The Matrix',                      year: 1999, director: 'The Wachowskis',      slug: 'the-matrix',            stills: 4 },
  { title: 'Interstellar',                    year: 2014, director: 'Christopher Nolan',   slug: 'interstellar',          stills: 5 },
  { title: 'One Battle After Another',        year: 2025, director: 'Paul Thomas Anderson',slug: 'one-battle-after-another', stills: 4 },
  { title: 'The Departed',                    year: 2006, director: 'Martin Scorsese',     slug: 'the-departed',          stills: 4 },
  { title: 'Across the Spider-Verse',         year: 2023, director: 'Joaquim Dos Santos',  slug: 'across-the-spider-verse', stills: 5 },
  { title: 'Django Unchained',                year: 2012, director: 'Quentin Tarantino',   slug: 'django-unchained',      stills: 4 },
  { title: 'Memento',                         year: 2000, director: 'Christopher Nolan',   slug: 'memento',               stills: 4 },
  { title: 'Avengers: Infinity War',          year: 2018, director: 'The Russo Brothers',  slug: 'infinity-war',          stills: 4 },
  { title: 'Dune: Part Two',                  year: 2024, director: 'Denis Villeneuve',    slug: 'dune-part-two',         stills: 5 },
  { title: 'Avengers: Endgame',               year: 2019, director: 'The Russo Brothers',  slug: 'endgame',               stills: 4 },
  { title: 'Coco',                            year: 2017, director: 'Lee Unkrich',         slug: 'coco',                  stills: 4 },
  { title: 'The Dark Knight Rises',           year: 2012, director: 'Christopher Nolan',   slug: 'dark-knight-rises',     stills: 4 },
  { title: 'Your Name',                       year: 2016, director: 'Makoto Shinkai',      slug: 'your-name',             stills: 5 },
  { title: 'Oldboy',                          year: 2003, director: 'Park Chan-wook',      slug: 'oldboy',                stills: 4 },
  { title: '3 Idiots',                        year: 2009, director: 'Rajkumar Hirani',     slug: '3-idiots',              stills: 4 },
  { title: 'Joker',                           year: 2019, director: 'Todd Phillips',       slug: 'joker',                 stills: 4 },
  { title: 'Incendies',                       year: 2010, director: 'Denis Villeneuve',    slug: 'incendies',             stills: 4 },
  { title: 'Up',                              year: 2009, director: 'Pete Docter',         slug: 'up',                    stills: 4 },
  { title: 'Like Stars on Earth',             year: 2007, director: 'Aamir Khan',          slug: 'like-stars-on-earth',   stills: 4 },
  { title: 'Attack on Titan: The Last Attack',year: 2024, director: 'Yuichiro Hayashi',    slug: 'aot-last-attack',       stills: 4 },
];

/**
 * Expanded to one entry per still. `src` is a convention, not a promise — the
 * file may not exist yet, and the engine handles that.
 */
export const FRAMES = FILMS.flatMap(f =>
  Array.from({ length: f.stills }, (_, i) => ({
    title: f.title,
    year: f.year,
    director: f.director,
    src: `img/frames/${f.slug}-${i + 1}.jpg`,
  }))
);

export { FILMS };
