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

/** Hides the cursor and control bar after inactivity, restores on any movement. */
export function autoHideControls(stage) {
  let timer = null;

  const wake = () => {
    stage.classList.remove('idle');
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Don't hide while a panel is open — the user is clearly still interacting.
      if (stage.querySelector('.panel:not([hidden])')) return;
      stage.classList.add('idle');
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
 */
export function banner(host, { id, kind = 'info', title, body, code, sticky = false }) {
  if (id) host.querySelector(`[data-banner="${id}"]`)?.remove();

  const el = document.createElement('div');
  el.className = `banner ${kind}`;
  if (id) el.dataset.banner = id;

  const close = document.createElement('button');
  close.className = 'banner-x';
  close.textContent = '✕';
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
