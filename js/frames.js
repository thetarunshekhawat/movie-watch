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
 * `current` is a float index; everything else is derived from it. Four modes
 * write to it, and only one is ever active:
 *
 *   auto    dwell, then step: hold a composition for DWELL_MS, then ease
 *           through exactly one index over MOVE_MS. Reads as someone stepping
 *           through a contact sheet rather than a conveyor belt — and during
 *           the dwell nothing changes, so the loop skips the draw entirely.
 *           That is most frames.
 *   manual  a wheel or a drag is moving it directly, followed by friction.
 *   glide   tweening to a specific index — click-to-centre, and the snap that
 *           lands a flick on a whole frame.
 *   hold    stationary after an interaction. Resumes `auto` IDLE_MS later, so
 *           the stack does not lurch back into motion under the cursor.
 *
 * Anything the person does wins immediately: auto never fights an input, it
 * just waits its turn.
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
  TITLE_MIN_W: 128, // below this the plate is too small to hold a title
  DPR_CAP: 1.5,
  PIXEL_BUDGET: 4e6,
  GRADE: 'grayscale(1) contrast(.92) brightness(.85)',

  // ── Interaction ──
  WHEEL_STEP: 340,  // wheel pixels that equal one index step
  DRAG_STEP: 190,   // pointer pixels along the arms that equal one index step
  DRAG_SLOP: 6,     // movement under this is a click, not a drag
  FRICTION: 7,      // e-folds per second of flick velocity
  MAX_VEL: 9,       // index steps per second — a hard flick still stays legible
  WHEEL_IDLE_MS: 130, // no wheel event for this long ⇒ the gesture is over
  SNAP_MS: 520,     // settling onto a whole frame after a flick
  GLIDE_MS: 900,    // click-to-centre
  IDLE_MS: 2600,    // hands off this long ⇒ the stack resumes on its own
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

// Motion. See the header — `mode` is the state machine.
let mode = 'auto';        // 'auto' | 'manual' | 'glide' | 'hold'
let vel = 0;              // index steps per second, during a flick
let wheelIdle = 0;        // ms since the last wheel event
let held = false;         // a wheel gesture or a finger is driving `current`
let glideFrom = 0, glideTo = 0, glideT = 0, glideDur = 0;
let idleT = 0;            // ms spent in 'hold'

// Input
let hits = [];            // last frame's plate rects, NEAREST first
let hover = -1;           // slot under the cursor, or -1
let ptr = null;           // { id, x0, y0, at0, startCurrent, moved, lastX, lastY, lastT }

// Backdrop
let bg = [];              // the two cross-fading .backdrop layers
let bgTop = 0;            // which one is currently showing
let bgIndex = -1;         // slot it is showing

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
    // Needed when `src` points at a remote CDN (the TMDB `--urls` route).
    // Harmless for same-origin files. Without it the mip canvas is tainted —
    // which does not break drawImage, but would break any future pixel read.
    if (/^https?:/i.test(slot.src)) img.crossOrigin = 'anonymous';
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
  // A hovered plate is a click target, and has to say so. Full opacity plus a
  // solid white rule is the whole affordance — no scale, no shadow: the plates
  // are packed edge to edge, so anything that changes a plate's geometry would
  // shove its neighbours around.
  const hot = slot.index === hover;
  if (hot) alpha = 1;
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
  ctx.strokeStyle = hot ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.38)';
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

  // 5. the title, printed ON the still in its top-left corner. Someone who has
  //    not seen the film still has to be able to tell what they are looking at,
  //    and a caption floating outside the plate stops reading as belonging to
  //    it once the frames are stacked edge to edge.
  if (w >= CONFIG.TITLE_MIN_W) drawTitle(slot, x, y, w, h, alpha, t);

  ctx.globalAlpha = 1;
}

/**
 * Title block, top-left, over a diagonal scrim.
 *
 * The scrim is a linear gradient run along the corner diagonal, which paints
 * as a soft triangular wedge — dark where the text sits, gone by the middle of
 * the frame, so it never reads as a bar laid across the picture. Without it the
 * title is unreadable the moment a still happens to be bright in that corner,
 * and we cannot know in advance which ones are.
 */
function drawTitle(slot, x, y, w, h, alpha, t) {
  const near = Math.abs(t) < 0.75;
  const size = Math.max(9, w * 0.052);
  const pad = size * 0.85;

  // Diagonal wedge. Reaches ~62% across and down at full size.
  const g = ctx.createLinearGradient(x, y, x + w * 0.62, y + h * 0.62);
  g.addColorStop(0, 'rgba(0,0,0,.9)');
  g.addColorStop(0.45, 'rgba(0,0,0,.42)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = alpha * (near ? 1 : 0.75);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // Title in italic — the house style throughout the app.
  ctx.globalAlpha = alpha * (near ? 1 : 0.8);
  ctx.fillStyle = '#fff';
  ctx.font = `italic ${size}px ${fontStack()}`;
  ctx.fillText(fitText(slot.title, w - pad * 2), x + pad, y + pad);

  // Year and roman numeral beneath, letterspaced small — enough to place the
  // film in time without turning the corner into a caption block.
  if (w >= CONFIG.TITLE_MIN_W * 1.45) {
    ctx.globalAlpha = alpha * (near ? 0.62 : 0.4);
    ctx.font = `${size * 0.72}px ${fontStack()}`;
    const sub = [roman(slot.index), slot.year].filter(Boolean).join('   ');
    ctx.fillText(sub, x + pad, y + pad + size * 1.35);
  }

  ctx.globalAlpha = alpha;
}

/** Ellipsise to fit, so a long title never runs out of its own frame. */
function fitText(text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.trimEnd() + '…';
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

  hits.length = 0;
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
    // Nearest first, which is the reverse of paint order: the plate drawn last
    // is the one on top, so it must be the first thing hit-testing considers.
    hits.unshift({ i, x, y, w, h });
  }

  syncBackdrop();

  // adaptive degradation — never stutter next to a live WebRTC session
  const ms = performance.now() - t0;
  drawMs.push(ms);
  if (drawMs.length > 30) drawMs.shift();
  if (drawMs.length === 30) {
    const mean = drawMs.reduce((s, v) => s + v, 0) / 30;
    if (mean > 10 && degraded < 2) {
      degraded++;
      if (degraded === 1) { dpr = 1; resize(true); }
      else { CONFIG.DWELL_MS = 3600; CONFIG.TITLE_MIN_W = 200; }
      drawMs = [];
    }
  }
}

// ── Backdrop ───────────────────────────────────────────────────────────────

/**
 * Blow the corner still up behind the whole page, blurred and thrown out of
 * focus, cross-fading whenever a different frame reaches the corner.
 *
 * The source is the ORIGINAL image, not a mip: it is already decoded and in
 * the browser's cache by the time we ask for it (`loadSlot` fetched the same
 * URL), so this costs a paint and no network. Slots with no image are skipped
 * rather than blanked — a slate has nothing to blur, and dropping to black
 * mid-stack reads as a bug rather than as a gap.
 */
function syncBackdrop() {
  if (bg.length < 2) return;
  const i = ((Math.round(current) % N) + N) % N;
  if (i === bgIndex) return;

  const slot = slots[i];
  if (!slot || !slot.img || !slot.src) return;
  bgIndex = i;

  const next = bg[bgTop ^ 1];
  next.style.backgroundImage = `url("${slot.src}")`;
  next.classList.add('on');
  bg[bgTop].classList.remove('on');
  bgTop ^= 1;
}

// ── Loop ───────────────────────────────────────────────────────────────────

/** Advance `current` by whichever mode currently owns it. */
function advance(dt) {
  switch (mode) {
    case 'glide': {
      glideT += dt;
      const f = easeOutExpo(clamp(glideT / glideDur, 0, 1));
      current = glideFrom + (glideTo - glideFrom) * f;
      if (f >= 1) { current = glideTo; hold(); }
      return;
    }

    case 'manual': {
      // `held` means a wheel gesture or a finger is still supplying position
      // directly; we only take over once it stops.
      if (held) {
        wheelIdle += dt;
        if (ptr || wheelIdle < CONFIG.WHEEL_IDLE_MS) return;
        held = false;
        vel = 0;                      // a wheel gesture ends where it ends
      }
      current += vel * dt / 1000;
      vel *= Math.exp(-CONFIG.FRICTION * dt / 1000);
      if (Math.abs(vel) < 0.15) { vel = 0; snap(); }
      return;
    }

    case 'hold':
      idleT += dt;
      if (idleT >= CONFIG.IDLE_MS) resumeAuto();
      return;

    default: {                        // auto
      if (reduced) return;
      const cycle = CONFIG.DWELL_MS + CONFIG.MOVE_MS;
      cycleT += dt;
      while (cycleT >= cycle) { cycleT -= cycle; baseIndex++; }
      const moveT = cycleT - CONFIG.DWELL_MS;
      const frac = moveT <= 0 ? 0 : easeOutExpo(clamp(moveT / CONFIG.MOVE_MS, 0, 1));
      current = baseIndex + frac;
    }
  }
}

/** Tween to `to` (an absolute, possibly fractional index). */
function glide(to, dur) {
  glideFrom = current;
  glideTo = to;
  glideDur = dur;
  glideT = 0;
  mode = 'glide';
  start();
}

/** Land on a whole frame. Half-frame compositions look like a stalled load. */
function snap() {
  const to = Math.round(current);
  if (to === current) hold();
  else glide(to, CONFIG.SNAP_MS);
}

/** Stationary, and counting down to handing control back to `auto`. */
function hold() {
  mode = 'hold';
  idleT = 0;
}

function resumeAuto() {
  // Re-seat the auto clock on wherever the person left the stack, otherwise
  // the first auto step jumps back to where it would have been.
  baseIndex = Math.round(current);
  current = baseIndex;
  cycleT = 0;
  mode = 'auto';
  dirty = true;
}

function tick(ts) {
  raf = requestAnimationFrame(tick);
  if (dead) return;

  const dt = Math.min(50, ts - (lastTs || ts));
  lastTs = ts;

  advance(dt);

  // Nothing moved during the dwell — skip the draw entirely. This is most
  // frames, and it is the single biggest reason this is cheap to run.
  if (!dirty && current === lastDrawn) {
    // With reduced motion `auto` never advances, so nothing will change again
    // until an input arrives — and every input path calls start().
    if (reduced && mode === 'auto') park();
    return;
  }
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

// ── Input ──────────────────────────────────────────────────────────────────

/** Canvas-relative CSS pixels. draw() works in the same space. */
function local(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Topmost plate under a point, or null. `hits` is already nearest-first. */
function hitTest(x, y) {
  for (const r of hits) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

/**
 * Bring slot `i` to the corner.
 *
 * `offset(i)` is the wrapped distance, so `current + offset(i)` always lands on
 * that slot by the SHORT way round — without it, clicking the frame one step
 * behind the corner would run the stack the whole way through the other
 * twenty-odd films to reach it.
 */
function focus(i) {
  const t = offset(i);
  if (Math.abs(t) < 0.001) { hold(); return; }
  glide(current + t, CONFIG.GLIDE_MS);
}

function setHover(i) {
  if (i === hover) return;
  hover = i;
  canvas.classList.toggle('on-plate', i >= 0);
  dirty = true;
  start();
}

function onWheel(e) {
  if (dead) return;
  // The page itself does not scroll (body is overflow:hidden) and the lobby
  // column is a separate scroller that the cursor is not over, so nothing is
  // lost by claiming the gesture — and without preventDefault a trackpad can
  // still trigger the browser's own overscroll effects.
  e.preventDefault();
  // Trackpads send the dominant axis in whichever direction the hand moved,
  // and the stack runs along both edges, so either axis is meaningful.
  const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const px = e.deltaMode === 1 ? raw * 16 : e.deltaMode === 2 ? raw * H : raw;

  mode = 'manual';
  held = true;
  wheelIdle = 0;
  vel = 0;
  current += px / CONFIG.WHEEL_STEP;
  start();
}

/**
 * Pointer capture, but never fatal. It throws for a pointer id that is not
 * currently active — which a synthetic event, or a pointer the browser has
 * already released, both are. Losing capture only means the drag stops if the
 * cursor leaves the canvas; letting it throw would abandon the gesture
 * half-applied.
 */
function capture(fn, id) {
  try { canvas[fn]?.(id); } catch { /* not an active pointer */ }
}

function onPointerDown(e) {
  if (dead || e.button > 0) return;
  capture('setPointerCapture', e.pointerId);
  const p = local(e);
  ptr = {
    id: e.pointerId, x0: p.x, y0: p.y, startCurrent: current,
    moved: 0, lastX: p.x, lastY: p.y, lastT: performance.now(), vel: 0,
  };
  // Freeze wherever it is: grabbing something that is still drifting under the
  // finger is the difference between "I am holding this" and "it is holding me".
  mode = 'manual';
  held = true;
  wheelIdle = 0;
  vel = 0;
  start();
}

function onPointerMove(e) {
  if (dead) return;
  const p = local(e);

  if (!ptr) { setHover(hitTest(p.x, p.y)?.i ?? -1); return; }
  if (e.pointerId !== ptr.id) return;

  const dx = p.x - ptr.x0, dy = p.y - ptr.y0;
  ptr.moved = Math.max(ptr.moved, Math.hypot(dx, dy));
  if (ptr.moved < CONFIG.DRAG_SLOP) return;

  root.classList.add('dragging');
  setHover(-1);

  // Frames travel toward the corner as `current` grows — leftward along the
  // bottom, then up the left edge. So pushing the stack in either of those
  // directions runs it forward, and one combined term covers both arms and
  // every diagonal in between.
  const steps = -(dx + dy) / CONFIG.DRAG_STEP;
  current = ptr.startCurrent + steps;

  const now = performance.now();
  const ms = now - ptr.lastT;
  if (ms > 8) {
    const inst = -((p.x - ptr.lastX) + (p.y - ptr.lastY)) / CONFIG.DRAG_STEP / (ms / 1000);
    ptr.vel = ptr.vel * 0.6 + inst * 0.4;   // smoothed, or one jittery sample throws the flick
    ptr.lastX = p.x; ptr.lastY = p.y; ptr.lastT = now;
  }
}

function onPointerUp(e) {
  if (dead || !ptr || e.pointerId !== ptr.id) return;
  const { moved, vel: v } = ptr;
  const p = local(e);
  ptr = null;
  held = false;
  root.classList.remove('dragging');
  capture('releasePointerCapture', e.pointerId);

  if (moved < CONFIG.DRAG_SLOP) {
    // A tap, not a drag: centre whatever is under it.
    const hit = hitTest(p.x, p.y);
    if (hit) focus(hit.i);
    else snap();
    return;
  }
  vel = clamp(v, -CONFIG.MAX_VEL, CONFIG.MAX_VEL);
  mode = 'manual';
  start();
}

function onPointerCancel(e) {
  if (!ptr || e.pointerId !== ptr.id) return;
  ptr = null;
  held = false;
  root.classList.remove('dragging');
  snap();
}

function wireInput() {
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', () => { if (!ptr) setHover(-1); });
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
    // let ~12 decoded bitmaps go before the film starts. The backdrop holds a
    // full-size still of its own, so its layers have to go with them.
    for (const s of slots) { s.img = null; s.mips = null; }
    slots = [];
    bg = []; hits = []; ptr = null;
  };
  // transitionend does not fire if the tab backgrounds mid-fade
  // The .backdrop layers transition too, so listen for the one on #ambient
  // itself — a backdrop finishing its fade must not tear the layer down early.
  root.addEventListener('transitionend', e => {
    if (e.target === root) cleanup();
  });
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
  bg = [...root.querySelectorAll('.backdrop')];

  // Repeat the list up to SLOTS_MIN so the wrap seam always lands outside the
  // cull radius. A repeat sits 6 slots away at ~14% size — reads as rhythm.
  const src = interleave(FRAMES.length ? FRAMES : [{ title: 'Untitled' }]);
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

/**
 * Round-robin the manifest by film, so the four or five stills from one film
 * never sit next to each other.
 *
 * The manifest is authored film by film, which is how a human wants to edit
 * it — but the stack shows nine frames at once, so in source order a third of
 * the screen would be the same movie. Round-robin guarantees neighbours differ
 * while staying fully deterministic (no shuffle, so the composition is the
 * same on every load and the layout stays debuggable).
 */
function interleave(list) {
  const byFilm = new Map();
  for (const e of list) {
    if (!byFilm.has(e.title)) byFilm.set(e.title, []);
    byFilm.get(e.title).push(e);
  }
  const groups = [...byFilm.values()];
  const out = [];
  for (let i = 0; out.length < list.length; i++) {
    let added = false;
    for (const g of groups) if (g[i]) { out.push(g[i]); added = true; }
    if (!added) break;
  }
  return out;
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
  wireInput();

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
