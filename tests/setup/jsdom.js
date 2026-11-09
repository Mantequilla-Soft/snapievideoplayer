// Runs before every player (jsdom) test file. jsdom has no media playback,
// no matchMedia and no ResizeObserver; give the code harmless stand-ins so
// it can boot. Tests that care about these replace them with vi.stubGlobal.
import { vi } from 'vitest';

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  });
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

// HTMLMediaElement methods jsdom leaves "not implemented".
Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, writable: true, value() { return Promise.resolve(); } });
Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, writable: true, value() {} });
Object.defineProperty(HTMLMediaElement.prototype, 'load', { configurable: true, writable: true, value() {} });

globalThis.fetch = vi.fn(async (url) => {
  throw new Error(`Unmocked fetch in a test: ${url}. Stub it with vi.stubGlobal('fetch', ...).`);
});
