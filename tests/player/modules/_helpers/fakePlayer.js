// A small stand-in for a Video.js player: only what the player modules touch.
import { vi } from 'vitest';

export function createFakePlayer({
  currentTime = 0, duration = 100, paused = true, hasStarted = true, ended = false, fullscreen = false,
  withFullscreenButton = false, withSeekBar = true,
} = {}) {
  const state = { currentTime, duration, paused, hasStarted, ended, fullscreen };
  const handlers = new Map();

  const root = document.createElement('div');
  root.className = 'video-js';
  const controlBarEl = document.createElement('div');
  controlBarEl.className = 'vjs-control-bar';
  root.appendChild(controlBarEl);
  const progressEl = document.createElement('div');
  progressEl.className = 'vjs-progress-control';
  controlBarEl.appendChild(progressEl);
  const seekBarEl = document.createElement('div');
  seekBarEl.className = 'vjs-progress-holder';
  progressEl.appendChild(seekBarEl);
  let fsButton = null;
  if (withFullscreenButton) {
    fsButton = document.createElement('button');
    fsButton.className = 'vjs-fullscreen-control';
    controlBarEl.appendChild(fsButton);
  }
  document.body.appendChild(root);

  const player = {
    state,
    fsButton,
    el: () => root,
    controlBar: {
      el: () => controlBarEl,
      progressControl: withSeekBar
        ? { el: () => progressEl, seekBar: { el: () => seekBarEl } }
        : undefined,
    },
    on: vi.fn((ev, fn) => {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(fn);
    }),
    trigger(ev) { (handlers.get(ev) || []).forEach((fn) => fn()); },
    listenerCount(ev) { return (handlers.get(ev) || []).length; },
    currentTime: vi.fn(() => state.currentTime),
    duration: vi.fn(() => state.duration),
    paused: vi.fn(() => state.paused),
    pause: vi.fn(() => { state.paused = true; }),
    hasStarted: vi.fn(() => state.hasStarted),
    ended: vi.fn(() => state.ended),
    isFullscreen: vi.fn(() => state.fullscreen),
    exitFullscreen: vi.fn(() => { state.fullscreen = false; }),
  };
  return player;
}

/** Give an element a fixed layout box (jsdom has no layout). */
export function setRect(el, { left = 0, top = 0, width = 0, height = 0 } = {}) {
  el.getBoundingClientRect = () => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {},
  });
}
