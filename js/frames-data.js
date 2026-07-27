/**
 * The stills shown in the ambient corner stack on the landing screen and in
 * the waiting room.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  TO ADD YOUR OWN IMAGES
 *
 *  1. Drop landscape files into  img/frames/  (make the folder; it is not
 *     tracked yet). Roughly 16:9. 1600px wide is plenty — they are never
 *     drawn larger than about a third of the viewport, and everything is
 *     pre-scaled into mipmaps at load.
 *  2. Set `src` on the entry below. A relative path from the site root:
 *        src: 'img/frames/blade-runner-2049.jpg'
 *  3. That is the whole job. Nothing else needs to change.
 *
 *  Entries with no `src` — or whose file fails to load — draw as a numbered
 *  slate with crop marks instead. That is a designed state, not a fallback
 *  that looks broken, so a half-filled list is fine to ship.
 *
 *  The titles below are PLACEHOLDERS chosen for layout realism. Replace them
 *  with whatever you actually want to show; they carry no meaning to the code.
 *
 *  Fewer than 12 entries is fine — the engine repeats the list to fill its
 *  12 slots, and a repeat lands 6 slots away at ~14% of the size, so it reads
 *  as intentional rather than as a bug. More than 12 is also fine.
 * ─────────────────────────────────────────────────────────────────────────
 */

export const FRAMES = [
  { title: 'Blade Runner 2049',        year: 2017, director: 'Denis Villeneuve',   src: null },
  { title: 'In the Mood for Love',     year: 2000, director: 'Wong Kar-wai',       src: null },
  { title: 'There Will Be Blood',      year: 2007, director: 'Paul Thomas Anderson', src: null },
  { title: 'Mad Max: Fury Road',       year: 2015, director: 'George Miller',      src: null },
  { title: 'The Grand Budapest Hotel', year: 2014, director: 'Wes Anderson',       src: null },
  { title: 'Arrival',                  year: 2016, director: 'Denis Villeneuve',   src: null },
  { title: 'Moonlight',                year: 2016, director: 'Barry Jenkins',      src: null },
  { title: 'Come and See',             year: 1985, director: 'Elem Klimov',        src: null },
  { title: 'Spirited Away',            year: 2001, director: 'Hayao Miyazaki',     src: null },
  { title: 'No Country for Old Men',   year: 2007, director: 'Joel & Ethan Coen',  src: null },
  { title: 'Portrait of a Lady on Fire', year: 2019, director: 'Céline Sciamma',   src: null },
  { title: '2001: A Space Odyssey',    year: 1968, director: 'Stanley Kubrick',    src: null },
];
