// Boots src/main.js the way a browser does: URL, DOM, fetch, then the
// DOMContentLoaded handler. Every scenario gets a fresh module instance.
import { vi } from 'vitest';
import { hub, resetHub } from './fakes.js';

export const VIDEO_URL = 'https://play.3speak.tv/hls/badadib/xyz/manifest.m3u8';
export const FALLBACK_URL = 'https://ipfs-3speak.b-cdn.net/ipfs/QmBadadib/manifest.m3u8';

export function videoFixture(over = {}) {
  return {
    success: true,
    type: 'embed',
    owner: 'badadib',
    permlink: 'xyz',
    title: 'Badadib test video',
    status: 'published',
    isPlaceholder: false,
    videoUrl: VIDEO_URL,
    videoUrlFallback1: VIDEO_URL,
    videoUrlFallback2: VIDEO_URL,
    videoUrlFallback3: VIDEO_URL,
    thumbnail: 'https://images.3speak.tv/badadib/xyz.jpg',
    duration: 120,
    views: 1234,
    short: false,
    ...over,
  };
}

const TEMPLATE = `
  <div class="player-wrapper">
    <img class="player-logo" id="logo-top-left" alt="">
    <video id="snapie-player" class="video-js vjs-default-skin" controls></video>
    <img class="player-logo" id="logo-bottom-right" alt="">
  </div>
  <div id="current-source"></div>
  <div id="player-state"></div>
  <div id="view-count"></div>
`;

// ---- document/window listener tracking, so a previous module instance's
// handlers (DOMContentLoaded, message, keydown...) never run again.
const tracked = [];
function installTracking() {
  if (globalThis.__mainTracking) return;
  globalThis.__mainTracking = true;
  for (const target of [document, window]) {
    const orig = target.addEventListener.bind(target);
    target.addEventListener = (type, fn, opts) => {
      tracked.push({ target, type, fn, opts });
      return orig(type, fn, opts);
    };
  }
}
installTracking();

export function listeners(type) {
  return tracked.filter((l) => l.type === type);
}

const restorers = [];
export function stubProp(obj, key, value) {
  const own = Object.getOwnPropertyDescriptor(obj, key);
  Object.defineProperty(obj, key, { configurable: true, get: () => value });
  restorers.push(() => {
    if (own) Object.defineProperty(obj, key, own);
    else delete obj[key];
  });
}

export function cleanup() {
  while (tracked.length) {
    const { target, type, fn, opts } = tracked.pop();
    target.removeEventListener(type, fn, opts);
  }
  while (restorers.length) restorers.pop()();
  delete window.__3sAdDebug;
}

export async function flush(n = 30) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function respond(spec) {
  if (spec instanceof Error) throw spec;
  const { status = 200, body = {} } = spec;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError(`Unexpected token '<', "${body.slice(0, 9)}"... is not valid JSON`);
      return body;
    },
  };
}

// Answers the player's own /api routes. `routes` maps a path to a response
// spec ({ status, body }), an Error (network failure) or a function returning one.
export function installFetch(routes = {}, video = videoFixture()) {
  const table = {
    '/api/embed': { body: video },
    '/api/watch': { body: video },
    '/api/stream': { status: 404, body: { found: false } },
    '/api/view': { body: { success: true, counted: true } },
    '/api/watch/start': { body: { sid: 'sid-badadib', token: 'tok-1', beatSeconds: 5 } },
    '/api/watch/beat': { body: { ok: true } },
    '/api/duration': { body: { success: true } },
    '/api/timeline': { body: { timeline: null } },
    ...routes,
  };
  const fetchMock = vi.fn(async (url, init) => {
    const path = String(url).split('?')[0];
    let spec = Object.prototype.hasOwnProperty.call(table, path) ? table[path] : null;
    if (typeof spec === 'function') spec = await spec(url, init);
    if (!spec) return respond({ status: 404, body: { error: 'no route ' + path } });
    return respond(spec);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export function calls(fetchMock, path) {
  return fetchMock.mock.calls.filter(([u]) => String(u).split('?')[0] === path);
}

export function bodyOf(call) {
  return JSON.parse(call[1].body);
}

/**
 * Boot main.js for one scenario.
 * opts.url       path + query (default an embed of badadib/xyz)
 * opts.iframe    run as if inside an iframe (window.parent is a stub)
 * opts.routes    /api overrides, see installFetch
 * opts.video     the /api/embed + /api/watch body
 * opts.ua / platform / maxTouchPoints   navigator overrides
 * opts.setup(hub) runs after the hub reset and before main.js is imported
 */
export async function boot(opts = {}) {
  const {
    url = '/embed?v=badadib/xyz', iframe = true, routes, video,
    ua, platform, maxTouchPoints, setup,
  } = opts;
  cleanup();
  resetHub();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('style');
  document.body.className = '';
  document.body.removeAttribute('style');
  document.body.innerHTML = TEMPLATE;
  window.history.replaceState({}, '', url);
  const parent = { postMessage: vi.fn() };
  if (iframe) vi.stubGlobal('parent', parent);
  if (ua !== undefined) stubProp(navigator, 'userAgent', ua);
  if (platform !== undefined) stubProp(navigator, 'platform', platform);
  if (maxTouchPoints !== undefined) stubProp(navigator, 'maxTouchPoints', maxTouchPoints);
  stubProp(document, 'visibilityState', opts.visibility || 'visible');
  const fetchMock = installFetch(routes, video);
  if (setup) await setup(hub);

  vi.resetModules();
  const mod = await import('../../../../src/main.js');
  const ready = listeners('DOMContentLoaded');
  const handler = ready[ready.length - 1].fn;
  await handler.call(document, new Event('DOMContentLoaded'));
  await flush();
  return { mod, player: hub.player, ab: hub.adBreak, fetch: fetchMock, parent, hub };
}

/** Post a command to the player the way an embedding page would. */
export function send(data) {
  window.dispatchEvent(new MessageEvent('message', { data, origin: 'https://3speak.tv' }));
}

/** All messages the player posted to the parent, optionally of one type. */
export function posted(parent, type) {
  const all = parent.postMessage.mock.calls.map((c) => c[0]);
  return type ? all.filter((m) => m && m.type === type) : all;
}

export { hub };
