/**
 * ui.js — control bar behaviour, fullscreen, banners, keyboard shortcuts.
 *
 * Two things here are easy to get wrong and are called out in PROJECT.md:
 *
 *   • Fullscreen targets the STAGE container, not the <video>. In fullscreen only
 *     the fullscreened element and its descendants render, so calling it on the
 *     video makes the webcam tiles, chat and controls all disappear.
 *
 *   • Keyboard shortcuts are suppressed while a text field has focus, or typing a
 *     space in chat pauses the movie for both people.
 */

const IDLE_MS = 3000;

/**
 * Hides the cursor and control bar after inactivity, restores on any movement.
 *
 * `onIdleChange(idle)` fires only on an actual transition, so callers can react to
 * the control bar appearing — subtitles shift up out from under it.
 */
export function autoHideControls(stage, onIdleChange = () => {}) {
  let timer = null;
  // Starts "idle" so the initial wake() below counts as a real transition and
  // fires onIdleChange once — otherwise nothing would tell the caller that the
  // control bar is on screen until the first time it hides and comes back.
  let idle = true;

  const setIdle = v => {
    if (v === idle) return;
    idle = v;
    stage.classList.toggle('idle', v);
    onIdleChange(v);
  };

  const wake = () => {
    setIdle(false);
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Don't hide while a panel is open — the user is clearly still interacting.
      if (stage.querySelector('.panel:not([hidden])')) return;
      setIdle(true);
    }, IDLE_MS);
  };

  ['pointermove', 'pointerdown', 'keydown'].forEach(ev =>
    stage.addEventListener(ev, wake)
  );
  wake();
  return wake;
}

/** Fullscreen the container so overlays survive. */
export function toggleFullscreen(stage) {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
  } else {
    (stage.requestFullscreen || stage.webkitRequestFullscreen)?.call(stage);
  }
}

/**
 * Wire up shortcuts.
 *
 * `map` is { key: handler }. Keys are matched case-insensitively against event.key.
 */
export function bindKeys(map) {
  window.addEventListener('keydown', e => {
    // The critical guard: never steal keys from a text field.
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const handler = map[e.key] || map[e.key.toLowerCase()];
    if (!handler) return;
    e.preventDefault();
    handler(e);
  });
}

/** Same guard, for keyup-driven controls like push-to-talk. */
export function bindKeyUp(map) {
  window.addEventListener('keyup', e => {
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
      return;
    }
    const handler = map[e.key] || map[e.key.toLowerCase()];
    if (handler) handler(e);
  });
}

/**
 * Show a banner. Returns a dismiss function.
 * `id` makes a banner replaceable, so repeated calls don't stack duplicates.
 * `action` adds a button — for the banners that report a problem they can also fix.
 */
export function banner(host, { id, kind = 'info', title, body, code, action, sticky = false }) {
  if (id) host.querySelector(`[data-banner="${id}"]`)?.remove();

  const el = document.createElement('div');
  el.className = `banner ${kind}`;
  if (id) el.dataset.banner = id;

  const close = document.createElement('button');
  close.className = 'banner-x';
  close.textContent = '×';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);

  if (title) {
    const b = document.createElement('b');
    b.textContent = title;
    el.appendChild(b);
  }
  if (body) {
    el.appendChild(document.createTextNode(body));
  }
  if (code) {
    const c = document.createElement('code');
    c.textContent = code;
    el.appendChild(c);
  }
  if (action) {
    const b = document.createElement('button');
    b.className = 'banner-action';
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', action.onClick);
    el.appendChild(b);
  }

  host.appendChild(el);
  if (!sticky) setTimeout(() => el.remove(), 9000);
  return () => el.remove();
}

export function centerStatus(el, text) {
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.hidden = false;
}

/** Close buttons on panels, wired by data-close="panelId". */
export function bindPanelCloses(root) {
  root.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.close);
      if (target) target.hidden = true;
    });
  });
}

/**
 * Close any open side panel when the user clicks away from it.
 *
 * Two exemptions are load-bearing, not preferences:
 *
 *   • THE BUTTON THAT OPENS A PANEL. Panel buttons toggle, so dismissing on the
 *     way down and toggling on the way up cancel out — the panel reopens in the
 *     same gesture and the button looks broken. Every panel therefore declares its
 *     opener with `data-owner`, and clicks inside that opener are left alone.
 *
 *   • THE CONTROL BAR. Reaching for the volume slider with chat open is still
 *     "using the app", not "dismissing the chat". Clicking the video, a webcam
 *     tile or the empty stage does dismiss, which is the point.
 *
 * `pointerdown` rather than `click`, so it lands at the start of the gesture and
 * a drag that begins outside the panel dismisses it too.
 */
export function bindDismissOnOutside(root, panelIds, { exempt = [] } = {}) {
  root.addEventListener('pointerdown', e => {
    if (exempt.some(el => el?.contains(e.target))) return;

    for (const id of panelIds) {
      const panel = document.getElementById(id);
      if (!panel || panel.hidden) continue;
      if (panel.contains(e.target)) continue;

      const owner = panel.dataset.owner && document.getElementById(panel.dataset.owner);
      if (owner?.contains(e.target)) continue;

      panel.hidden = true;
    }
  });
}

/**
 * Close every panel except one.
 *
 * Panels are all pinned to the same top-right corner, so two open at once means
 * one is invisibly stacked under the other — you close the top one and a second
 * panel is revealed, which reads as the close button having failed. Opening any
 * panel closes the rest.
 */
export function closeOtherPanels(panelIds, exceptId) {
  for (const id of panelIds) {
    if (id === exceptId) continue;
    const panel = document.getElementById(id);
    if (panel) panel.hidden = true;
  }
}
