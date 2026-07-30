#!/usr/bin/env node
/**
 * test-room.mjs — prove that a created room actually exists.
 *
 * Launches TWO headless Chrome instances. The first creates a room; the second
 * opens the share link and joins it. Both are driven through the real UI — real
 * file picker, real preflight, real Trystero — and the script reports what the
 * joiner was actually told. This is the check that "the room exists" is a fact and
 * not a hope, and it is the only way to test this app without two humans.
 *
 *   node tools/test-room.mjs                      # test the local working copy
 *   node tools/test-room.mjs --deployed           # test the live GitHub Pages site
 *   node tools/test-room.mjs --url https://…/     # test any deployment
 *   node tools/test-room.mjs --movie path.mp4     # default: ./testclip.mp4
 *   node tools/test-room.mjs --block 5            # blackhole the first N relays
 *   node tools/test-room.mjs --block all          # blackhole every relay in the pool
 *   node tools/test-room.mjs --break-ice          # let them find each other, deny the route
 *   node tools/test-room.mjs --headful            # watch it happen
 *
 * Exits 0 only if both browsers end up inside the room.
 *
 * NO DEPENDENCIES, deliberately — this project has no npm and no build step, so the
 * harness talks to Chrome over the DevTools Protocol using Node built-ins only. It
 * needs nothing installed but the Chrome you already have.
 *
 * WHY THIS EXISTS: "Room doesn't exist" was reported twice with two entirely
 * different causes (no TURN relay, then a five-relay signaling monoculture — see
 * js/net.js). Both were invisible from one browser on one network, and both were
 * found in minutes once two browsers could be pointed at each other on demand.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── arguments ──

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt  = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const DEPLOYED = 'https://thetarunshekhawat.github.io/movie-watch/';
const HEADFUL  = flag('--headful');
const MOVIE    = resolve(ROOT, opt('--movie', 'testclip.mp4'));
const BLOCK    = opt('--block', '0');

/**
 * Reproduce the failure that matters most: discovery works, the route does not.
 *
 * This is the institutional-CGNAT case in PROJECT.md — the peers find each other
 * over the relays and then cannot build a path — and it is the branch of the join
 * gate that is otherwise untestable, because two browsers on one machine can always
 * reach each other over loopback.
 *
 * Chrome's own flags will not produce it: `disable_non_proxied_udp` is inert without
 * a configured proxy (tried; the pair connected in 2ms anyway). So instead the guest
 * page gets a shim that starves ICE — candidates are dropped in both directions,
 * while offer/answer signaling over Nostr proceeds untouched. Trystero still
 * registers the peer, no candidate pair can ever be nominated, and the connection
 * hangs exactly the way a hostile network makes it hang.
 */
const BREAK_ICE = flag('--break-ice');
const TURN_HOST = 'global.relay.metered.ca';

/**
 * Installed before any app code runs, so it wraps the constructor the app will use.
 *
 * Deliberately surgical: everything except candidate exchange behaves normally, so
 * what is being tested is the app's reaction to an unreachable peer and not some
 * broader breakage of WebRTC.
 */
const STARVE_ICE = `(() => {
  const Real = window.RTCPeerConnection;

  // Trystero does NOT trickle: it waits for gathering to finish and ships the
  // candidates inside the SDP. Blocking onicecandidate/addIceCandidate alone
  // therefore changed nothing — the pair still connected in 2ms. Candidates have to
  // be stripped out of the description itself.
  const strip = sdp => (sdp ?? '').split('\\r\\n')
    .filter(l => !l.startsWith('a=candidate:'))
    .join('\\r\\n');

  window.RTCPeerConnection = function (...args) {
    const pc = new Real(...args);
    const setRemote = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = desc => setRemote(
      desc?.sdp ? { type: desc.type, sdp: strip(desc.sdp) } : desc);
    pc.addIceCandidate = () => Promise.resolve();
    return pc;
  };
  window.RTCPeerConnection.prototype = Real.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Real);
})()`;
const ROOM     = opt('--room', `test-${Math.random().toString(36).slice(2, 8)}`);

/**
 * The five relays this app's appId hashes to, in selection order.
 *
 * Only used by --block, which blackholes them at the DNS layer to reproduce a
 * network that filters them — the failure real users hit. Keep in step with the
 * RELAY_REDUNDANCY comment in js/net.js.
 */
const APP_RELAYS = [
  'social.amanah.eblessing.co',
  'nostr.vulpem.com',
  'schnorr.me',
  'testnet-relay.samt.st',
  'relay-can.zombi.cloudrodion.com',
];

/** How long to let the joiner search before calling it a failure. */
const JOIN_TIMEOUT_MS = 45_000;
/** Preflight decodes the file, which on a big movie is not instant. */
const PREFLIGHT_TIMEOUT_MS = 90_000;

const t0 = Date.now();
const log = (tag, msg) =>
  console.log(`${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s ${tag} ${msg}`);

// ── locating Chrome ──

const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of CHROME_CANDIDATES[process.platform] ?? []) {
    try { await stat(p); return p; } catch { /* try the next one */ }
  }
  throw new Error(
    'Could not find Chrome. Set CHROME_PATH to the browser binary.\n' +
    '  macOS:   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n' +
    '  Windows: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
}

// ── a very small static server, so the local copy is testable ──
//
// ES module imports (Trystero from the CDN) are blocked from file:// by CORS, so
// the working copy has to be served over http to be testable at all.

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp4': 'video/mp4', '.vtt': 'text/vtt', '.ico': 'image/x-icon',
};

async function serveRoot() {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = join(ROOT, path === '/' ? 'index.html' : path);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      }).end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

// ── the DevTools Protocol client ──
//
// Node has had a global WebSocket since v22, which is what makes a dependency-free
// CDP client possible. Everything below is the minimum needed to drive a page:
// evaluate script, set a file input, and read results back.

class Chrome {
  constructor(tag) { this.tag = tag; this.id = 0; this.pending = new Map(); }

  static async launch(tag, { chromePath, blockedHosts = [], breakIce = false }) {
    const c = new Chrome(tag);
    c.profile = await mkdtemp(join(tmpdir(), 'mw-test-'));
    const port = 9500 + Math.floor(Math.random() * 400);

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${c.profile}`,
      '--no-first-run', '--no-default-browser-check',
      // The app asks for a camera. Grant it with a fake device so nothing blocks on
      // a permission prompt no script can click.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Two Chromes on one machine would otherwise share a mDNS view of each other;
      // this keeps the pair honest about being separate peers.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      'about:blank',
    ];
    if (!HEADFUL) args.unshift('--headless=new');

    // MAP <host> 0.0.0.0 is what a filtering network looks like to Chrome. The TURN
    // server goes in the same list under --break-ice so there is no fallback route.
    const hosts = breakIce ? [...blockedHosts, TURN_HOST] : blockedHosts;
    if (hosts.length) {
      args.unshift(`--host-resolver-rules=${hosts.map(h => `MAP ${h} 0.0.0.0`).join(', ')}`);
    }

    c.proc = spawn(chromePath, args, { stdio: 'ignore' });

    // Poll the debug endpoint rather than parsing stderr — it is the thing we
    // actually need, and it is ready exactly when it answers.
    const deadline = Date.now() + 30_000;
    let wsUrl = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        wsUrl = (await r.json()).webSocketDebuggerUrl;
        if (wsUrl) break;
      } catch { /* not up yet */ }
      await sleep(200);
    }
    if (!wsUrl) throw new Error(`${tag}: Chrome never opened its debugging port`);

    c.ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => { c.ws.onopen = ok; c.ws.onerror = () => bad(new Error('ws failed')); });
    c.ws.onmessage = e => c.#dispatch(JSON.parse(e.data));

    // One tab, attached flat so page commands can be addressed by sessionId.
    const { targetId } = await c.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    c.sessionId = sessionId;

    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('DOM.enable');

    // Must be installed before the document runs, which is the whole point of
    // addScriptToEvaluateOnNewDocument — an eval after navigation would land after
    // Trystero already captured the real constructor.
    if (breakIce) {
      await c.send('Page.addScriptToEvaluateOnNewDocument', { source: STARVE_ICE });
    }

    // Surface page-side failures; a silent exception here reads as a mysterious
    // timeout thirty seconds later.
    c.consoleErrors = [];
    c.on('Runtime.exceptionThrown', p => {
      const text = p.exceptionDetails?.exception?.description
                ?? p.exceptionDetails?.text ?? 'unknown';
      c.consoleErrors.push(text);
      log(c.tag, `PAGE ERROR: ${String(text).split('\n')[0].slice(0, 160)}`);
    });

    return c;
  }

  #dispatch(msg) {
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
                : p.resolve(msg.result);
      return;
    }
    this.handlers?.get(msg.method)?.forEach(fn => fn(msg.params));
  }

  on(method, fn) {
    (this.handlers ??= new Map()).set(method, [...(this.handlers.get(method) ?? []), fn]);
  }

  send(method, params = {}) {
    const id = ++this.id;
    const payload = { id, method, params };
    // Browser-level commands must NOT carry a sessionId; page-level ones must.
    if (this.sessionId && !method.startsWith('Target.')) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    // Wait for our own markup rather than a load event — the app is ES modules and
    // the elements we drive appear when those evaluate, which is after load.
    await this.waitFor(`!!document.getElementById('landingCard')`, 30_000, 'app to boot');
  }

  /** Evaluate an expression in the page and return its value. */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) {
      throw new Error(`eval failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value;
  }

  /** Poll an expression until truthy. Returns false on timeout rather than throwing. */
  async waitFor(expression, ms, what = expression) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { if (await this.eval(expression)) return true; } catch { /* mid-navigation */ }
      await sleep(250);
    }
    log(this.tag, `timed out waiting for ${what}`);
    return false;
  }

  /**
   * Put a real file into a real <input type=file>.
   *
   * There is no way to do this from page script — assigning to `.files` is
   * forbidden — so it has to go through the protocol. This is the single reason
   * this harness needs CDP rather than a page-side fetch loop.
   */
  async setFile(selector, path) {
    const { root } = await this.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`${selector} not found`);
    await this.send('DOM.setFileInputFiles', { files: [path], nodeId });
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', {});
    await (await import('node:fs/promises')).writeFile(path, Buffer.from(data, 'base64'));
  }

  async close() {
    try { this.ws?.close(); } catch { /* already gone */ }
    this.proc?.kill('SIGKILL');
    await rm(this.profile, { recursive: true, force: true }).catch(() => {});
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── driving the app ──

/**
 * Fill in the setup card and submit it.
 *
 * The first click is retried until it takes, and that is not paranoia: the markup
 * exists before main.js has evaluated, so a single well-timed click lands on a
 * button with no listener yet and is silently swallowed. Clicking until the card
 * actually changes is the only reliable signal that the app is live, because the
 * app exposes nothing else to wait on.
 */
async function setup(c, { choice, name, room }) {
  const onSetup = `!document.getElementById('setupCard').hidden`;

  if (choice) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !await c.eval(onSetup)) {
      await c.eval(`document.getElementById('${choice}').click()`);
      await sleep(300);
    }
  }

  if (!await c.waitFor(onSetup, 15_000, 'setup card')) {
    throw new Error(`${c.tag}: never reached the setup card`);
  }

  // Set values the way a person does — the app listens for `input`, and a bare
  // value assignment fires nothing, which silently skips the share-link hint.
  await c.eval(`(() => {
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('displayName', ${JSON.stringify(name)});
    set('roomCode', ${JSON.stringify(room)});
  })()`);

  await c.setFile('#videoFile', MOVIE);
  log(c.tag, 'file chosen, waiting for preflight…');

  if (!await c.waitFor(`!document.getElementById('joinBtn').disabled`, PREFLIGHT_TIMEOUT_MS, 'preflight')) {
    const why = await c.eval(`document.getElementById('videoStatus').textContent`);
    throw new Error(`${c.tag}: preflight rejected the movie — ${why}`);
  }
  log(c.tag, `preflight ok: ${(await c.eval(`document.getElementById('videoStatus').textContent`)).slice(0, 90)}`);

  await c.eval(`document.getElementById('joinBtn').click()`);
}

/** Everything worth knowing about where a browser currently is. */
const readState = c => c.eval(`(() => {
  const card = ['landingCard','setupCard','statusCard'].find(id => !document.getElementById(id).hidden);
  const stage = document.getElementById('stage');
  return {
    card: card ?? '(none)',
    inRoom: !!stage && !stage.hidden,
    title: document.getElementById('statusTitle')?.textContent?.trim() ?? '',
    body: document.getElementById('statusBody')?.textContent?.trim() ?? '',
    roster: [...document.querySelectorAll('#rosterList li')].map(li => li.textContent.trim()),
  };
})()`);

// ── the test ──

/**
 * Every relay hostname Trystero might use, read out of the library itself.
 *
 * Blackholing all of them simulates a network that filters the matchmaking layer
 * wholesale — which is what the "Can't reach the matchmaking network" message
 * exists for, and the only way to test that message honestly. Read at runtime
 * rather than hardcoded so it cannot drift from whatever the CDN is serving.
 */
async function allRelayHosts(chromePath, base) {
  const probe = await Chrome.launch('PROBE', { chromePath });
  try {
    // Load the app's own origin, not about:blank — a dynamic import needs a real
    // origin, and an opaque one refuses the CDN outright.
    await probe.goto(base);
    const urls = await probe.eval(
      `import('https://esm.run/trystero').then(m => m.defaultRelayUrls)`);
    return [...new Set(urls.map(u => new URL(u).hostname))];
  } finally {
    await probe.close();
  }
}

async function main() {
  const chromePath = await findChrome();

  try { await stat(MOVIE); } catch {
    throw new Error(`No movie file at ${MOVIE}. Pass --movie <path> to a small playable mp4.`);
  }

  let base = opt('--url', null);
  let served = null;
  if (!base) {
    if (flag('--deployed')) base = DEPLOYED;
    else { served = await serveRoot(); base = served.url; }
  }

  const blockedHosts = BLOCK === 'all'
    ? await allRelayHosts(chromePath, base)
    : APP_RELAYS.slice(0, Number(BLOCK));

  console.log(`\ntarget   ${base}${served ? '  (local working copy)' : ''}`);
  console.log(`room     ${ROOM}`);
  console.log(`movie    ${MOVIE}`);
  if (BREAK_ICE) console.log('mode     --break-ice (discovery allowed, no usable route)');
  if (blockedHosts.length) {
    console.log(`blocked  ${blockedHosts.length} relay host(s)`
      + `${blockedHosts.length > 6 ? '' : ': ' + blockedHosts.join(', ')}`);
  }
  console.log('');

  let host = null, guest = null, ok = false;

  try {
    // ── the host creates the room ──
    host = await Chrome.launch('HOST ', { chromePath, blockedHosts, breakIce: BREAK_ICE });
    await host.goto(base);
    await setup(host, { choice: 'createChoice', name: 'Host', room: ROOM });

    if (!await host.waitFor(`!document.getElementById('stage').hidden`, 20_000, 'host to enter the room')) {
      throw new Error('the host never got into its own room — creating is supposed to be unconditional');
    }
    log('HOST ', `in the room. Share link: ${base}?room=${ROOM}`);

    // A real guest is always at least a few seconds behind, and the host needs that
    // time on the relays to be findable at all.
    await sleep(4000);

    // ── the guest joins through the share link ──
    guest = await Chrome.launch('GUEST', { chromePath, blockedHosts, breakIce: BREAK_ICE });
    // No Create/Join click: arriving with ?room= is supposed to open the join form
    // directly, and testing that is part of testing the share link.
    await guest.goto(`${base}?room=${encodeURIComponent(ROOM)}`);
    await setup(guest, { choice: null, name: 'Guest', room: ROOM });

    // ── watch ──
    const deadline = Date.now() + JOIN_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
      const [h, g] = await Promise.all([readState(host), readState(guest)]);

      const line = `HOST[${h.inRoom ? 'in room' : h.card}] GUEST[${g.inRoom ? 'in room' : g.title || g.card}]`;
      if (line !== last) { log('     ', line); last = line; }

      if (h.inRoom && g.inRoom) { ok = true; break; }

      if (/doesn't exist|Can’t reach|can’t connect|closed/.test(g.title)) {
        log('GUEST', `REJECTED: ${g.title}`);
        log('GUEST', g.body);
        break;
      }
      await sleep(1000);
    }

    // ── report ──
    const [h, g] = await Promise.all([readState(host), readState(guest)]);
    console.log(`\n  host roster:  ${JSON.stringify(h.roster)}`);
    console.log(`  guest roster: ${JSON.stringify(g.roster)}`);

    for (const c of [host, guest]) {
      const r = await c.eval(`(() => {
        // Reach Trystero the same way net.js does, so this reports the real transport.
        return import('https://esm.run/trystero').then(({ getRelaySockets }) => {
          const s = Object.entries(getRelaySockets());
          return { total: s.length, open: s.filter(([, w]) => w.readyState === 1).length };
        }).catch(() => null);
      })()`).catch(() => null);
      if (r) console.log(`  ${c.tag} relays: ${r.open}/${r.total} open`);
    }

    if (!ok) {
      await host.screenshot(join(ROOT, 'test-host.png'));
      await guest.screenshot(join(ROOT, 'test-guest.png'));
      console.log('\n  screenshots written: test-host.png, test-guest.png');
    }

    console.log(`\n${ok ? '  PASS — the room exists and both browsers are in it.'
                       : '  FAIL — the guest never got into the room.'}\n`);
  } finally {
    await host?.close();
    await guest?.close();
    served?.server.close();
  }

  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error(`\n  ERROR: ${err.message}\n`);
  process.exit(2);
});
