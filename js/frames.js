/**
 * Ambient frame stack.
 *
 * A slow, self-running contact sheet of movie stills in the bottom-left
 * corner. Adapted from the scroll effect on depoluxe.xyz — theirs is driven by
 * a virtual scroller; ours has no scroll at all and advances on its own.
 *
 * ── Geometry ──────────────────────────────────────────────────────────────
 * Every frame is sized by its distance from the current index:
 *
 *     h(t) = BASE_H · K^|t|          w = h · AR
 *
 * and positioned by the *cumulative* size of everything between it and the
 * corner, so the plates pack edge to edge:
 *
 *     cum(x) = BASE · (1 - K^x) / (1 - K)
 *
 *     t >  0 : x = cumW(t),   y = H - h            along the bottom, rightward
 *     t <= 0 : x = 0,         y = H - cumH(-t) - h up the left edge
 *
 * `cum` is the geometric partial sum extended to real x — it equals the
 * discrete sum exactly at integers (cum(0)=0, cum(1)=BASE, cum(2)=BASE(1+K))
 * and is smooth in between, so the stack packs perfectly for ANY K. Depoluxe
 * uses a telescoping form that only packs at K = 0.5; K there gives one
 * dominant frame, and we want two or three, hence 0.72 and this formulation.
 *
 * Both branches agree at t = 0, which is the shared corner frame.
 *
 * ── Motion ────────────────────────────────────────────────────────────────
 * Dwell, then step: hold a composition for DWELL_MS, then ease through
 * exactly one index over MOVE_MS. Reads as someone stepping through a contact
 * sheet rather than a conveyor belt — and during the dwell nothing changes, so
 * the loop skips the draw entirely. That is most frames.
 *
 * ── Lifecycle ─────────────────────────────────────────────────────────────
 * Starts on import, mounted at body level. `mount(stage)` re-parents it when
 * the room is entered (moving a canvas in the DOM keeps its bitmap; only
 * assigning width/height clears it). `stop()` fades it out, removes it and
 * drops every decoded bitmap — it never resumes, so nothing competes with the
 * film and the rAF is gone before playback starts.
 */

import { FRAMES } from './frames-data.js';

export const CONFIG = {
  K: 0.72,          // falloff per step. 0.68-0.74 is the usable range.
  // Corner frame height as a fraction of viewport height. 0.26 puts the plate
  // at roughly a third of the width, matching depoluxe's proportion and
  // leaving the centre of the screen free for the UI. Larger than ~0.32 and
  // the stack stops reading as a corner composition and takes over the page.
  BASE_H: 0.26,
  // Hard cap on how far the arms reach, independent of the viewport-derived
  // cull radius. A gentle K keeps frames legible for longer, which is the
  // point, but without this the two arms run the full width and height and
  // the composition stops being a CORNER. 4 keeps both arms short of the far
  // edges at every viewport we care about.
  MAX_RADIUS: 4,
  AR: 16 / 9,
  SLOTS_MIN: 12,    // >= 2R + 2, so alpha reaches 0 before the wrap seam
  DWELL_MS: 2400,
  MOVE_MS: 1600,
  FADE_BAND: 1.0,   // units of t over which a frame fades out at the cull edge
  LABEL_RADIUS: 2,  // only label frames this close to the corner
  DPR_CAP: 1.5,
  PIXEL_BUDGET: 4e6,
  GRADE: 'grayscale(1) contrast(.92) brightness(.85)',
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
  'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];

const roman = n => ROMAN[n + 1] || String(n + 1);
const easeOutExpo = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ── State ──────────────────────────────────────────────────────────────────

let root = null;          // #ambient
let canvas = null;
let ctx = null;
let slots = [];           // { title, year, director, src, img, mips }
let N = 0;

let W = 0, H = 0, dpr = 1;
let baseIndex = 0, cycleT = 0, current = 0, lastDrawn = NaN;
let raf = 0, lastTs = 0, dead = false, mounted = false;
let dirty = true;         // force one draw (resize, font load, first paint)
let reduced = false;
let ro = null;

// Adaptive degradation
let drawMs = [], degraded = 0;

// ── Geometry helpers ───────────────────────────────────────────────────────

const K = () => CONFIG.K;
const baseH = () => CONFIG.BASE_H * H;
const baseW = () => baseH() * CONFIG.AR;

/** Geometric partial sum, extended continuously. cum(0)=0, cum(1)=base. */
const cum = (x, base) => base * (1 - Math.pow(K(), x)) / (1 - K());

/**
 * How far from the corner a frame can be before it is fully off-screen.
 * Derived from the measured viewport rather than hardcoded, because the exit
 * point depends on BASE/viewport — a tall window or an ultrawide fullscreen
 * would otherwise pop, or waste draws on frames nobody can see.
 */
function cullRadius() {
  const solve = (span, base) => {
    // cum(t, base) > span  →  K^t < 1 - (1-K)·span/base
    const rhs = 1 - (1 - K()) * span / base;
    if (rhs <= 0) return Infinity;       // never exits within finite t
    return Math.log(rhs) / Math.log(K());
  };
  const up = solve(H, baseH());          // climbs off the top
  const along = solve(W, baseW());       // marches off the right
  const ceiling = Math.min(CONFIG.MAX_RADIUS, CONFIG.SLOTS_MIN / 2 - 1);
  return clamp(Math.max(up, along), 2.5, ceiling);
}

/** Signed offset of slot i from `current`, wrapped to [-N/2, N/2). */
function offset(i) {
  let t = i - current;
  return ((t + N / 2) % N + N) % N - N / 2;
}

// ── Image loading and mipmaps ──────────────────────────────────────────────

/**
 * Pre-scale each still to three sizes with the grade already baked in.
 * Drawing a 1600px still down to 180px every frame is the classic way to make
 * a canvas loop expensive; picking the smallest mip that still covers the
 * required width removes it, and applying the filter here means `ctx.filter`
 * is never touched inside the loop.
 */
function buildMips(slot) {
  const img = slot.img;
  if (!img) return;
  const maxW = Math.ceil(baseW() * dpr);
  if (!maxW || slot.mipsFor === maxW) return;

  const mips = [];
  for (const div of [1, 2, 4]) {
    const w = Math.max(16, Math.round(maxW / div));
    const h = Math.round(w / CONFIG.AR);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.filter = CONFIG.GRADE;
    // cover-crop the source into the 16:9 plate
    const sw = img.width, sh = img.height;
    const scale = Math.max(w / sw, h / sh);
    const cw = w / scale, ch = h / scale;
    cx.drawImage(img, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
    mips.push(c);
  }
  slot.mips = mips;
  slot.mipsFor = maxW;
}

function pickMip(slot, needW) {
  if (!slot.mips) return null;
  for (let i = slot.mips.length - 1; i >= 0; i--) {
    if (slot.mips[i].width >= needW) return slot.mips[i];
  }
  return slot.mips[0];
}

async function loadSlot(slot) {
  if (!slot.src) return;
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = slot.src;
    await img.decode();
    slot.img = img;
    buildMips(slot);
    dirty = true;
  } catch {
    // A missing or broken file draws as a slate. One bad path must never
    // leave a hole in the stack.
    slot.img = null;
  }
}

// ── Drawing ────────────────────────────────────────────────────────────────

/** Snap to a half device-pixel so a 1px rule stays a hairline. */
const hair = v => (Math.round(v * dpr) + 0.5) / dpr;

function drawPlate(slot, x, y, w, h, alpha, t) {
  ctx.globalAlpha = alpha;

  // 1. the plate. Deterministic per slot so the stack reads as distinct
  //    plates rather than one repeated tile.
  //
  //    An empty slate gets a gentle top-to-bottom falloff and sits much
  //    lighter than a filled one. A real still brings its own luminance; a
  //    slate has only this to separate it from a pure-black page, and flat
  //    near-black rectangles read as broken rather than as placeholders.
  if (slot.mips) {
    ctx.fillStyle = `hsl(0 0% ${5 + slot.shade * 4}%)`;
    ctx.fillRect(x, y, w, h);
  } else {
    const hi = 15 + slot.shade * 9;
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, `hsl(0 0% ${hi}%)`);
    g.addColorStop(1, `hsl(0 0% ${hi * 0.45}%)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }

  // 2. the still, if we have one
  const mip = pickMip(slot, w * dpr);
  if (mip) ctx.drawImage(mip, x, y, w, h);

  // 3. hairline border
  ctx.strokeStyle = 'rgba(255,255,255,.38)';
  ctx.lineWidth = 1 / dpr;
  ctx.strokeRect(hair(x), hair(y), w, h);

  // 4. crop ticks — the film-production register mark. This is what makes an
  //    empty plate read as a slate rather than as a missing image.
  const tick = Math.min(w, h) * 0.06;
  ctx.strokeStyle = 'rgba(255,255,255,.6)';
  ctx.beginPath();
  for (const [cx, cy, sx, sy] of [
    [x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1],
  ]) {
    ctx.moveTo(hair(cx), hair(cy) + sy * tick);
    ctx.lineTo(hair(cx), hair(cy));
    ctx.lineTo(hair(cx) + sx * tick, hair(cy));
  }
  ctx.stroke();

  // 5. label, only near the corner
  if (Math.abs(t) <= CONFIG.LABEL_RADIUS) drawLabel(slot, x + w, y, alpha, t);

  ctx.globalAlpha = 1;
}

function drawLabel(slot, x, y, alpha, t) {
  const pad = 0.9 * rem();
  const size = Math.max(10, 0.8125 * rem());
  const near = Math.abs(t) < 0.5;
  const lx = x + pad;

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // numeral, then a short rule, then the title in italic
  ctx.globalAlpha = alpha * (near ? 1 : 0.45);
  ctx.font = `${size}px ${fontStack()}`;
  ctx.fillStyle = '#fff';
  const num = roman(slot.index);
  ctx.fillText(num, lx, y);

  const numW = ctx.measureText(num).width;
  const ruleX = lx + numW + pad * 0.6;
  const ruleW = size * 1.4;
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = 1 / dpr;
  ctx.beginPath();
  ctx.moveTo(ruleX, hair(y + size * 0.62));
  ctx.lineTo(ruleX + ruleW, hair(y + size * 0.62));
  ctx.stroke();

  ctx.font = `italic ${size * 1.15}px ${fontStack()}`;
  ctx.fillText(`“${slot.title}”`, ruleX + ruleW + pad * 0.6, y - size * 0.1);

  // second line: director and year, muted
  ctx.globalAlpha = alpha * (near ? 0.55 : 0.3);
  ctx.font = `${size * 0.88}px ${fontStack()}`;
  const sub = [slot.director, slot.year].filter(Boolean).join('  ·  ');
  if (sub) ctx.fillText(sub, lx, y + size * 1.7);

  ctx.globalAlpha = alpha;
}

const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
const fontStack = () => '"EB Garamond", "EBG Fallback", serif';

function draw() {
  const t0 = performance.now();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const R = cullRadius();
  const bh = baseH(), bw = baseW();

  // far to near, so nearer plates overlap correctly at the corner
  const vis = [];
  for (let i = 0; i < N; i++) {
    const t = offset(i);
    if (Math.abs(t) > R) continue;
    vis.push({ i, t });
  }
  vis.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));

  for (const { i, t } of vis) {
    const a = Math.abs(t);
    const h = bh * Math.pow(K(), a);
    const w = h * CONFIG.AR;
    let x, y;
    if (t > 0) {                       // along the bottom, marching right
      x = cum(t, bw);
      y = H - h;
    } else {                           // up the left edge
      x = 0;
      y = H - cum(-t, bh) - h;
    }
    const alpha = clamp((R - a) / CONFIG.FADE_BAND, 0, 1);
    if (alpha <= 0.002) continue;
    drawPlate(slots[i], x, y, w, h, alpha, t);
  }

  // adaptive degradation — never stutter next to a live WebRTC session
  const ms = performance.now() - t0;
  drawMs.push(ms);
  if (drawMs.length > 30) drawMs.shift();
  if (drawMs.length === 30) {
    const mean = drawMs.reduce((s, v) => s + v, 0) / 30;
    if (mean > 10 && degraded < 2) {
      degraded++;
      if (degraded === 1) { dpr = 1; resize(true); }
      else { CONFIG.DWELL_MS = 3600; CONFIG.LABEL_RADIUS = 1; }
      drawMs = [];
    }
  }
}

// ── Loop ───────────────────────────────────────────────────────────────────

function tick(ts) {
  raf = requestAnimationFrame(tick);
  if (dead) return;

  const dt = Math.min(50, ts - (lastTs || ts));
  lastTs = ts;

  const cycle = CONFIG.DWELL_MS + CONFIG.MOVE_MS;
  cycleT += dt;
  while (cycleT >= cycle) { cycleT -= cycle; baseIndex++; }

  const moveT = cycleT - CONFIG.DWELL_MS;
  const frac = moveT <= 0 ? 0 : easeOutExpo(clamp(moveT / CONFIG.MOVE_MS, 0, 1));
  current = baseIndex + frac;

  // Nothing moved during the dwell — skip the draw entirely. This is most
  // frames, and it is the single biggest reason this is cheap to run.
  if (!dirty && current === lastDrawn) return;
  lastDrawn = current;
  dirty = false;
  draw();
}

function start() {
  if (dead || raf) return;
  lastTs = 0;
  raf = requestAnimationFrame(tick);
}

function park() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}

// ── Sizing ─────────────────────────────────────────────────────────────────

function resize(force = false) {
  if (!canvas) return;
  const r = root.getBoundingClientRect();
  const cw = Math.round(r.width), chh = Math.round(r.height);
  if (!cw || !chh) return;

  const budget = Math.sqrt(CONFIG.PIXEL_BUDGET / (cw * chh));
  const want = degraded >= 1 ? 1
    : Math.min(window.devicePixelRatio || 1, CONFIG.DPR_CAP, budget);

  // Only touch width/height when the backing store actually changes:
  // assigning either clears the bitmap and resets context state, and the
  // fullscreen transition fires the observer repeatedly with identical boxes.
  if (!force && cw === W && chh === H && Math.abs(want - dpr) < 0.01) return;

  W = cw; H = chh; dpr = want;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  for (const s of slots) buildMips(s);
  dirty = true;
  if (reduced) draw();
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Move the layer into `parent` (used when the room is entered). */
export function mount(parent) {
  if (dead || !root || !parent || root.parentNode === parent) return;
  parent.insertBefore(root, parent.firstChild);
  mounted = true;
  resize(true);
}

/** Force a redraw — used when the webfont finishes loading. */
export function invalidate() {
  dirty = true;
  if (reduced && ctx) draw();
}

/**
 * Fade out, remove, and never come back. Idempotent: applyPhase() calls this
 * on every phase application, and admit() may call it before that.
 */
export function stop() {
  if (dead) return;
  dead = true;
  park();
  if (ro) { ro.disconnect(); ro = null; }
  if (!root) return;

  root.classList.add('leaving');
  const cleanup = () => {
    root?.remove();
    root = null; canvas = null; ctx = null;
    // let ~12 decoded bitmaps go before the film starts
    for (const s of slots) { s.img = null; s.mips = null; }
    slots = [];
  };
  // transitionend does not fire if the tab backgrounds mid-fade
  root.addEventListener('transitionend', cleanup, { once: true });
  setTimeout(cleanup, 900);
}

// ── Boot ───────────────────────────────────────────────────────────────────

function build() {
  root = document.getElementById('ambient');
  if (!root) return false;
  canvas = root.querySelector('canvas');
  if (!canvas) return false;
  ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return false;

  // Repeat the list up to SLOTS_MIN so the wrap seam always lands outside the
  // cull radius. A repeat sits 6 slots away at ~14% size — reads as rhythm.
  const src = FRAMES.length ? FRAMES : [{ title: 'Untitled' }];
  N = Math.max(CONFIG.SLOTS_MIN, src.length);
  slots = Array.from({ length: N }, (_, i) => {
    const f = src[i % src.length];
    return {
      ...f, index: i, shade: (i * 0.618033) % 1,
      img: null, mips: null, mipsFor: 0,
    };
  });
  return true;
}

async function boot() {
  if (!build()) return;

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduced = mq.matches;
  mq.addEventListener('change', e => {
    reduced = e.matches;
    if (reduced) { park(); dirty = true; draw(); }
    else start();
  });

  ro = new ResizeObserver(() => resize());
  ro.observe(root);
  resize(true);

  // ctx.fillText silently uses the fallback if the webfont is not ready. In
  // reduced-motion mode only one frame is ever drawn, so without this the
  // labels would be stuck in the fallback forever.
  Promise.race([
    document.fonts.load('1rem "EB Garamond"'),
    new Promise(r => setTimeout(r, 1500)),
  ]).then(() => invalidate());
  document.fonts.ready.then(() => invalidate());

  for (const s of slots) loadSlot(s);

  document.addEventListener('visibilitychange', () => {
    if (dead) return;
    if (document.hidden) park();
    else if (!reduced) start();
  });

  if (reduced) draw();
  else start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export default { mount, stop, invalidate, CONFIG };
