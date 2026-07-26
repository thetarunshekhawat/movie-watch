/**
 * chat.js — text chat, floating bubbles, and emoji reactions.
 *
 * Messages appear in two places: the chat panel (full history) and as a bubble that
 * floats over the video and auto-dismisses. The bubble is the point — it means you
 * can leave the panel closed and still see what they said without looking away.
 */

const EMOJI = ['😂', '😍', '😱', '🔥', '👏', '😭', '🤯', '💀', '❤️', '🍿'];

const BUBBLE_MS = 6000;
const MAX_BUBBLES = 4;

export function createChat({
  panel, log, form, input, badge, bubbles, reactions, picker, selfName,
}) {
  let unread = 0;
  let peerName = 'Them';

  /** main.js assigns these. */
  const handlers = { onSend: () => {}, onReact: () => {} };

  // ── emoji picker ──
  picker.innerHTML = '';
  EMOJI.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => {
      handlers.onReact(e);
      flyEmoji(e);
      picker.hidden = true;
    });
    picker.appendChild(b);
  });

  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendMessage({ text, mine: true, who: selfName() });
    showBubble({ text, mine: true, who: 'You' });
    handlers.onSend(text);
  });

  function appendMessage({ text, mine, who, mediaTime }) {
    const el = document.createElement('div');
    el.className = `msg ${mine ? 'mine' : 'them'}`;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = mediaTime != null
      ? `${who} · ${stamp(mediaTime)}`
      : who;

    const body = document.createElement('span');
    body.textContent = text;   // textContent, never innerHTML — this is remote input

    el.append(meta, body);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function showBubble({ text, mine, who }) {
    const el = document.createElement('div');
    el.className = `bubble ${mine ? 'mine' : ''}`;

    const label = document.createElement('span');
    label.className = 'who';
    label.textContent = who;

    const body = document.createElement('span');
    body.textContent = text;

    el.append(label, body);
    bubbles.appendChild(el);

    while (bubbles.children.length > MAX_BUBBLES) bubbles.firstChild.remove();

    setTimeout(() => {
      el.classList.add('fade');
      setTimeout(() => el.remove(), 400);
    }, BUBBLE_MS);
  }

  function flyEmoji(emoji) {
    const el = document.createElement('div');
    el.className = 'react-fly';
    el.textContent = emoji;
    el.style.left = (12 + Math.random() * 70) + '%';
    el.style.setProperty('--spin', (Math.random() * 60 - 30) + 'deg');
    reactions.appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }

  function bumpBadge() {
    if (!panel.hidden) return;
    unread += 1;
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.hidden = false;
  }

  return {
    set onSend(fn) { handlers.onSend = fn; },
    set onReact(fn) { handlers.onReact = fn; },
    set peerName(n) { peerName = n || 'Them'; },

    /** A message arrived from the peer. */
    receive({ text, mediaTime }) {
      appendMessage({ text, mine: false, who: peerName, mediaTime });
      showBubble({ text, mine: false, who: peerName });
      bumpBadge();
    },

    receiveReaction(emoji) {
      flyEmoji(emoji);
    },

    /** Local system note — connection events and so on. */
    system(text) {
      const el = document.createElement('div');
      el.className = 'msg them';
      el.style.opacity = '.65';
      el.style.fontStyle = 'italic';
      el.textContent = text;
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    },

    togglePanel() {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        unread = 0;
        badge.hidden = true;
        input.focus();
        log.scrollTop = log.scrollHeight;
      }
      return !panel.hidden;
    },

    togglePicker() {
      picker.hidden = !picker.hidden;
    },

    flyEmoji,
  };
}

function stamp(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
