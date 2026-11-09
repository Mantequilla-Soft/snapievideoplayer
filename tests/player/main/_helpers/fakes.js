// Fakes for everything src/main.js imports. State lives on one hub kept on
// globalThis, so it survives vi.resetModules() and the mock factories, the
// tests and main.js all see the same objects.
import { vi } from 'vitest';

export const hub = globalThis.__mainHub || (globalThis.__mainHub = {});

// ---- video.js components main.js patches at import (drawTimelineInContentTime)
function makeComponents() {
  class SeekBar {
    constructor(player) { this.player_ = player; this.pending = null; }
    getPercent() { return 'orig-percent'; }
    getCurrentTime_() { return this.player_.currentTime(); }
    userSeek_(ct) { this.seekedTo = ct; return ct; }
    pendingSeekTime() { return this.pending; }
  }
  class TimeDisplay {
    constructor(player) { this.player_ = player; }
    updateContent() { return 'orig'; }
    updateTextNode_(v) { this.text = v; return v; }
  }
  return {
    SeekBar,
    CurrentTimeDisplay: class extends TimeDisplay {},
    DurationDisplay: class extends TimeDisplay {},
    RemainingTimeDisplay: class extends TimeDisplay {},
  };
}

// ---- the fake player
export class FakePlayer {
  constructor(id, options) {
    this.id = id;
    this.options_ = { ...options };
    this.handlers = {};
    this.s = {
      currentTime: 0, duration: NaN, paused: true, muted: !!options.muted, volume: 1,
      ended: false, videoWidth: 0, videoHeight: 0, fullscreen: false, userActive: true,
      error: null, currentSrc: '', source: null, networkState: 1, readyState: 0,
      playbackRate: 1, scrubbing: false,
    };
    // Results for upcoming play() calls: 'resolve' (default) or an Error to reject with.
    this.playResults = [];
    this.qualityList = [];
    this.liveTracker = { isLive: () => false };

    const video = document.getElementById(id);
    const el = document.createElement('div');
    el.className = 'video-js';
    const tech = document.createElement('video');
    tech.className = 'vjs-tech';
    el.appendChild(tech);
    const bar = document.createElement('div');
    bar.className = 'vjs-control-bar';
    el.appendChild(bar);
    if (video && video.parentNode) video.parentNode.insertBefore(el, video.nextSibling);
    else document.body.appendChild(el);
    this.el_ = el;
    this.techEl = tech;
    this.techObj = { el: () => tech };

    const fn = (name, impl) => { this[name] = vi.fn(impl); };
    const prop = (key) => function (v) { if (v === undefined) return this.s[key]; this.s[key] = v; return undefined; };
    fn('currentTime', prop('currentTime'));
    fn('duration', prop('duration'));
    fn('muted', prop('muted'));
    fn('volume', prop('volume'));
    fn('paused', function () { return this.s.paused; });
    fn('ended', function () { return this.s.ended; });
    fn('userActive', function () { return this.s.userActive; });
    fn('videoWidth', function () { return this.s.videoWidth; });
    fn('videoHeight', function () { return this.s.videoHeight; });
    fn('error', function () { return this.s.error; });
    fn('currentSrc', function () { return this.s.currentSrc; });
    fn('currentSource', function () { return this.s.source; });
    fn('networkState', function () { return this.s.networkState; });
    fn('readyState', function () { return this.s.readyState; });
    fn('buffered', function () { return { length: 0 }; });
    fn('playbackRate', function () { return this.s.playbackRate; });
    fn('scrubbing', function () { return this.s.scrubbing; });
    fn('getCache', function () { return { currentTime: this.s.cacheTime ?? this.s.currentTime }; });
    fn('isFullscreen', function () { return this.s.fullscreen; });
    fn('requestFullscreen', function () { this.s.fullscreen = true; });
    fn('exitFullscreen', function () { this.s.fullscreen = false; });
    fn('play', function () {
      const r = this.playResults.length ? this.playResults.shift() : 'resolve';
      if (r instanceof Error) return Promise.reject(r);
      this.s.paused = false;
      return Promise.resolve();
    });
    fn('pause', function () { this.s.paused = true; });
    fn('src', function (v) {
      if (v === undefined) return this.s.currentSrc;
      this.s.sources = v;
      const first = Array.isArray(v) ? v[0] : v;
      this.s.source = first;
      this.s.currentSrc = first && first.src;
      return undefined;
    });
    fn('load', () => {});
    fn('poster', () => {});
    fn('loop', () => {});
    fn('hlsQualitySelector', () => {});
    fn('qualityLevels', function () { return this.qualityList; });
    fn('fill', () => {});
    fn('fluid', () => {});
    fn('width', () => {});
    fn('height', () => {});
    fn('aspectRatio', () => {});
    fn('addClass', function (c) { this.el_.classList.add(c); });
    fn('removeClass', function (c) { this.el_.classList.remove(c); });
    fn('tech', function () { return this.techObj; });
  }

  el() { return this.el_; }

  on(type, cb) { (this.handlers[type] ||= []).push(cb); }

  one(type, cb) {
    const wrap = (...a) => { this.off(type, wrap); return cb.apply(this, a); };
    wrap.orig = cb;
    this.on(type, wrap);
  }

  off(type, cb) {
    const list = this.handlers[type];
    if (!list) return;
    this.handlers[type] = list.filter((h) => h !== cb && h.orig !== cb);
  }

  trigger(type, arg) {
    const list = (this.handlers[type] || []).slice();
    for (const h of list) h.call(this, arg === undefined ? { type } : arg);
  }

  // Convenience for tests: move the clock and announce it.
  tick(t) { this.s.currentTime = t; this.trigger('timeupdate'); }

  listenerCount(type) { return (this.handlers[type] || []).length; }
}

// ---- videojs default export
export const videojs = Object.assign(
  (id, options) => {
    const p = new FakePlayer(id, options);
    hub.player = p;
    hub.videojsCalls.push({ id, options });
    return p;
  },
  {
    getComponent: (name) => hub.components[name],
    getPlugin: (name) => hub.plugins[name],
    registerPlugin: (name, fn) => { hub.plugins[name] = fn; },
    log: () => {},
  },
);

// ---- adBreak
export function fakeAdBreak() {
  return {
    active: false, resolved: false, info: null, isPremiumViewer: false,
    bannerInfo: null, tickerInfo: null, bannerOverlay: null,
    spotConsumed: false, skipOffered: false,
    request: vi.fn(async () => null),
    resolve: vi.fn(async () => null),
    reset: vi.fn(),
    contentTime: vi.fn((t) => t),
    contentDuration: vi.fn((d) => d),
    playerTimeFor: vi.fn((c) => c),
    isInside: vi.fn(() => false),
    countdownAt: vi.fn(() => null),
    seekLocked: vi.fn(() => false),
    skipTargetFor: vi.fn(() => null),
    lockedSeekTarget: vi.fn(() => null),
    spotStart: vi.fn(() => null),
    endOfBreak: vi.fn(() => NaN),
    noteTime: vi.fn(),
    secondsUntilSkip: vi.fn(() => 0),
    canSkip: vi.fn(() => false),
    secondsRemaining: vi.fn(() => null),
    recordSkip: vi.fn(),
    isBannerVisible: vi.fn(() => false),
    bannerDueWithin: vi.fn(() => false),
    bannerClosable: vi.fn(() => false),
    reportBannerShown: vi.fn(),
    dismissBanner: vi.fn(async () => {}),
    retireSpot: vi.fn(),
    isTickerVisible: vi.fn(() => false),
    tickerWatched: vi.fn(),
  };
}

// ---- hls.js
export class FakeHls {
  constructor(cfg) {
    this.cfg = cfg;
    this.handlers = {};
    this.loadSource = vi.fn();
    this.attachMedia = vi.fn();
    this.destroy = vi.fn();
    hub.hlsInstances.push(this);
    if (hub.hlsThrows) throw new Error('hls boom');
  }
  on(ev, cb) { this.handlers[ev] = cb; }
  static isSupported() { return hub.hlsSupported; }
}
FakeHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed' };

// ---- the hub reset, run before each boot
export function resetHub() {
  hub.components = makeComponents();
  hub.plugins = {};
  hub.player = null;
  hub.videojsCalls = [];
  hub.adBreak = fakeAdBreak();
  hub.hlsInstances = [];
  hub.hlsSupported = true;
  hub.hlsThrows = false;
  hub.timeline = null;
  hub.timelineHooks = null;
  hub.timelineThrows = false;
  hub.scrub = null;
  hub.scrubThrows = false;
  hub.heatmap = null;
  hub.heatmapThrows = false;
  hub.tip = vi.fn();
  hub.live = vi.fn(async () => {});
  hub.subtitle = {
    cues: [],
    availableLanguages: ['en', 'es'],
    selectedLang: 'en',
    init: vi.fn(),
    selectLanguage: vi.fn(),
    checkAvailability: vi.fn(),
  };
  hub.caption = { init: vi.fn(), update: vi.fn(), onUpdate: vi.fn() };
}
if (!hub.components) resetHub();

// ---- module factories used by vi.mock in the test files
export const modules = {
  videojs: () => ({ default: videojs }),
  plugin: () => ({ default: function plugin() {} }),
  hls: () => ({ default: FakeHls }),
  adBreak: () => ({
    createAdBreak: () => hub.adBreak,
    AD_COUNTDOWN_FROM: 3,
    AD_BILLABLE_SECONDS: 3,
  }),
  scrubPreview: () => ({
    createScrubPreview: () => {
      if (hub.scrubThrows) throw new Error('scrub boom');
      hub.scrub = { setSource: vi.fn(), setLabel: vi.fn() };
      return hub.scrub;
    },
  }),
  heatmap: () => ({
    createHeatmap: () => {
      if (hub.heatmapThrows) throw new Error('heatmap boom');
      hub.heatmap = { setVideo: vi.fn() };
      return hub.heatmap;
    },
  }),
  timelineUI: () => ({
    createTimelineUI: (player, hooks) => {
      if (hub.timelineThrows) throw new Error('timeline boom');
      hub.timelineHooks = hooks;
      hub.timeline = { setTimeline: vi.fn(), update: vi.fn(), chapterLabel: vi.fn(() => 'Chapter') };
      return hub.timeline;
    },
  }),
  tipButton: () => ({ setTipVideo: (...a) => hub.tip(...a) }),
  captionUI: () => ({
    initCaptionUI: (...a) => hub.caption.init(...a),
    updateOverlay: (...a) => hub.caption.update(...a),
    onSubtitleUpdate: (...a) => hub.caption.onUpdate(...a),
    setCCButtonVisible: () => {},
  }),
  subtitleManager: () => ({
    default: new Proxy({}, { get: (_t, k) => hub.subtitle[k] }),
  }),
  live: () => ({ initLiveSession: (...a) => hub.live(...a) }),
};
