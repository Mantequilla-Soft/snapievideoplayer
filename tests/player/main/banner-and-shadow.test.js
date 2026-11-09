import './_helpers/mocks.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, cleanup, flush, hub } from './_helpers/boot.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

const q = (player, sel) => player.el().querySelector(sel);
const STITCHED = 'https://checker.3speak.tv/m/sess-1/manifest.m3u8';

describe('drawn banner overlay', () => {
  async function withOverlay(ov, info, opts) {
    const ctx = await boot(opts);
    ctx.ab.bannerOverlay = ov;
    ctx.ab.bannerInfo = info;
    ctx.ab.isBannerVisible.mockReturnValue(true);
    return ctx;
  }
  const INFO = {
    placement: { widthPct: 50, bottomPct: 8, maxHeightPct: 20, aspect: 4 },
    brand: { clickUrl: 'https://checker.3speak.tv/c/b1', productName: 'Badadib Beans' },
    durationSeconds: 5,
  };

  it('draws the image where it was booked, with label, link and a waiting close button', async () => {
    const { player, ab } = await withOverlay({ imageUrl: 'https://img/banner.png', label: 'Sponsored' }, INFO);
    player.tick(10);
    const box = q(player, '.vjs-banner-overlay');
    expect(box.style.width).toBe('50%');
    expect(box.style.bottom).toBe('8%');
    expect(box.style.maxHeight).toBe('20%');
    expect(box.style.aspectRatio).toBe('4');
    expect(box.style.display).toBe('block');
    const img = box.querySelector('img.vjs-banner-overlay-media');
    expect(img.getAttribute('src')).toBe('https://img/banner.png');
    expect(box.querySelector('.vjs-banner-overlay-label').textContent).toBe('Sponsored');
    const hit = box.querySelector('a.vjs-banner-overlay-hit');
    expect(hit.getAttribute('href')).toBe('https://checker.3speak.tv/c/b1');
    expect(hit.getAttribute('aria-label')).toBe("Open Badadib Beans's website in a new tab");
    const x = box.querySelector('.vjs-banner-overlay-close');
    expect(x.style.display).toBe('none');
    ab.bannerClosable.mockReturnValue(true);
    player.tick(16);
    expect(x.style.display).toBe('flex');
    // No burned click target alongside it, and no shadow copy.
    expect(q(player, '.vjs-banner-click')).toBeNull();
    expect(q(player, '.vjs-shadow-clean')).toBeNull();

    const surface = vi.fn();
    player.el().addEventListener('click', surface);
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(surface).not.toHaveBeenCalled();
  });

  it('re-shapes the box to the image once it has loaded', async () => {
    const { player } = await withOverlay({ imageUrl: 'https://img/banner.png' }, INFO);
    player.tick(10);
    const img = q(player, '.vjs-banner-overlay-media');
    Object.defineProperty(img, 'naturalWidth', { value: 600 });
    Object.defineProperty(img, 'naturalHeight', { value: 200 });
    img.dispatchEvent(new Event('load'));
    expect(q(player, '.vjs-banner-overlay').style.aspectRatio).toBe('3');
  });

  it('defaults the placement and the label, and has no link without a click URL', async () => {
    const { player } = await withOverlay({ imageUrl: 'https://img/b.png' }, null);
    player.tick(10);
    const box = q(player, '.vjs-banner-overlay');
    expect(box.style.width).toBe('60%');
    expect(box.style.bottom).toBe('6%');
    expect(box.style.maxHeight).toBe('15%');
    expect(box.style.aspectRatio).toBe('5.6');
    expect(box.querySelector('.vjs-banner-overlay-label').textContent).toBe('Ad');
    expect(box.querySelector('.vjs-banner-overlay-hit')).toBeNull();
    const img = box.querySelector('img');
    img.dispatchEvent(new Event('load')); // 0x0 keeps the placeholder
    expect(box.style.aspectRatio).toBe('5.6');
  });

  it('a link without a product name gets a generic label', async () => {
    const { player } = await withOverlay({ imageUrl: 'https://img/b.png' }, { brand: { clickUrl: 'https://c/1' } });
    player.tick(1);
    expect(q(player, '.vjs-banner-overlay-hit').getAttribute('aria-label')).toBe("Open the advertiser's website in a new tab");
  });

  it('a video creative streams through hls.js, silent and not looped', async () => {
    const { player } = await withOverlay({ videoUrl: 'https://cdn/banner.m3u8' }, INFO);
    player.tick(10);
    const media = q(player, 'video.vjs-banner-overlay-media');
    expect(media.muted).toBe(true);
    expect(media.loop).toBe(false);
    const h = hub.hlsInstances[0];
    expect(h.cfg).toEqual({ maxBufferLength: 10 });
    expect(h.loadSource).toHaveBeenCalledWith('https://cdn/banner.m3u8');
    expect(h.attachMedia).toHaveBeenCalledWith(media);
    Object.defineProperty(media, 'videoWidth', { value: 640 });
    Object.defineProperty(media, 'videoHeight', { value: 160 });
    media.dispatchEvent(new Event('loadedmetadata'));
    expect(q(player, '.vjs-banner-overlay').style.aspectRatio).toBe('4');
  });

  it('without MSE the video creative is given to the element directly', async () => {
    const { player } = await withOverlay({ videoUrl: 'https://cdn/banner.mp4' }, INFO, { setup: (h) => { h.hlsSupported = false; } });
    player.tick(10);
    expect(q(player, 'video.vjs-banner-overlay-media').getAttribute('src')).toBe('https://cdn/banner.mp4');
    expect(hub.hlsInstances).toHaveLength(0);
  });

  it('closes on the down event, once, and tells the ad break', async () => {
    const { player, ab } = await withOverlay({ imageUrl: 'https://img/b.png' }, INFO);
    ab.bannerClosable.mockReturnValue(true);
    player.tick(10);
    const box = q(player, '.vjs-banner-overlay');
    const x = box.querySelector('.vjs-banner-overlay-close');
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    x.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(box.style.display).toBe('none');
    expect(ab.dismissBanner).toHaveBeenCalledTimes(1);
    x.click();
    expect(ab.dismissBanner).toHaveBeenCalledTimes(1);
  });

  it('a close whose dismissal throws still hides it', async () => {
    const { player, ab } = await withOverlay({ imageUrl: 'https://img/b.png' }, INFO);
    ab.dismissBanner.mockImplementation(() => { throw new Error('x'); });
    player.tick(10);
    const box = q(player, '.vjs-banner-overlay');
    box.querySelector('.vjs-banner-overlay-close').click();
    expect(box.style.display).toBe('none');
  });

  it('hides when the banner window ends and rebuilds for a new creative', async () => {
    const { player, ab } = await withOverlay({ imageUrl: 'https://img/a.png' }, INFO);
    player.tick(10);
    const first = q(player, '.vjs-banner-overlay');
    ab.isBannerVisible.mockReturnValue(false);
    player.tick(40);
    expect(first.style.display).toBe('none');
    ab.isBannerVisible.mockReturnValue(true);
    ab.bannerOverlay = { imageUrl: 'https://img/b.png' };
    player.tick(41);
    const boxes = player.el().querySelectorAll('.vjs-banner-overlay');
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).not.toBe(first);
    // An overlay with no creative is not drawn.
    ab.bannerOverlay = {};
    player.tick(42);
    expect(boxes[0].style.display).toBe('none');
  });

  it('reports the impression once, after the booked seconds on screen', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { player, ab } = await withOverlay({ imageUrl: 'https://img/b.png' }, INFO);
    player.tick(10);
    vi.advanceTimersByTime(4999);
    player.tick(14);
    expect(ab.reportBannerShown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    player.tick(15);
    player.tick(16);
    expect(ab.reportBannerShown).toHaveBeenCalledTimes(1);
  });

  it('a failing report is not a crash', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { player, ab } = await withOverlay({ imageUrl: 'https://img/b.png' }, { ...INFO, durationSeconds: 1 });
    ab.reportBannerShown.mockImplementation(() => { throw new Error('x'); });
    player.tick(1);
    vi.advanceTimersByTime(1000);
    expect(() => player.tick(2)).not.toThrow();
  });
});

describe('burned banner click target and close', () => {
  const INFO = {
    advertiser: 'badadib',
    placement: { widthPct: 40, bottomPct: 10, maxHeightPct: 12, aspect: 6 },
    brand: { clickUrl: 'https://checker.3speak.tv/c/burn1' },
  };
  async function withBurned(info = INFO, opts) {
    const ctx = await boot(opts);
    ctx.ab.bannerInfo = info;
    ctx.ab.isBannerVisible.mockReturnValue(true);
    return ctx;
  }

  it('places a link over the burned pixels and a close button above it', async () => {
    const { player, ab } = await withBurned();
    player.tick(30);
    const a = q(player, 'a.vjs-banner-click');
    expect(a.getAttribute('href')).toBe('https://checker.3speak.tv/c/burn1');
    expect(a.getAttribute('aria-label')).toBe("Open badadib's website in a new tab");
    expect(a.style.width).toBe('40%');
    expect(a.style.bottom).toBe('10%');
    expect(a.style.aspectRatio).toBe('6');
    expect(a.style.maxHeight).toBe('12%');
    expect(a.style.display).toBe('block');
    const x = q(player, 'button.vjs-banner-close');
    expect(x.style.right).toBe('30%');
    expect(x.style.display).toBe('none');
    ab.bannerClosable.mockReturnValue(true);
    player.tick(36);
    expect(x.style.display).toBe('flex');
    // Same URL: not rebuilt.
    expect(player.el().querySelectorAll('.vjs-banner-click')).toHaveLength(1);
    ab.isBannerVisible.mockReturnValue(false);
    player.tick(60);
    expect(a.style.display).toBe('none');
    expect(x.style.display).toBe('none');
  });

  it('uses defaults and the product name when present, and rebuilds for a new URL', async () => {
    const { player, ab } = await withBurned({ brand: { clickUrl: 'https://c/1', productName: 'Badadib Beans' } });
    player.tick(1);
    const a = q(player, '.vjs-banner-click');
    expect(a.getAttribute('aria-label')).toBe("Open Badadib Beans's website in a new tab");
    expect(a.style.width).toBe('60%');
    ab.bannerInfo = { brand: { clickUrl: 'https://c/2' } };
    player.tick(2);
    const all = player.el().querySelectorAll('.vjs-banner-click');
    expect(all).toHaveLength(1);
    expect(all[0].getAttribute('aria-label')).toBe("Open the advertiser's website in a new tab");
  });

  it('no click URL, no target', async () => {
    const { player } = await withBurned({ brand: {} });
    player.tick(1);
    expect(q(player, '.vjs-banner-click')).toBeNull();
  });

  it('an overlay banner hides a burned target left from before', async () => {
    const { player, ab } = await withBurned();
    player.tick(1);
    ab.bannerOverlay = { imageUrl: 'https://img/x.png' };
    player.tick(2);
    expect(q(player, '.vjs-banner-click').style.display).toBe('none');
    expect(q(player, '.vjs-banner-close').style.display).toBe('none');
  });

  describe('closing without a ready shadow', () => {
    it('drops the buffer ahead with the fallback margin and makes VHS refetch it', async () => {
      const { player, ab } = await withBurned();
      const remove = vi.fn();
      const loader = { resetLoader: vi.fn(), monitorBuffer_: vi.fn() };
      player.techObj.vhs = { playlistController_: { sourceUpdater_: { remove }, mainSegmentLoader_: loader } };
      player.s.duration = 120;
      player.tick(30);
      const surface = vi.fn();
      player.el().addEventListener('click', surface);
      q(player, '.vjs-banner-close').click();
      expect(surface).not.toHaveBeenCalled();
      expect(q(player, '.vjs-banner-click').style.display).toBe('none');
      await flush();
      expect(ab.dismissBanner).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('video', 45, 120);
      expect(remove).toHaveBeenCalledWith('audio', 45, 120);
      expect(loader.resetLoader).toHaveBeenCalled();
      expect(loader.monitorBuffer_).toHaveBeenCalled();
      expect(player.src).toHaveBeenCalledTimes(1); // no reload
      expect(ab.retireSpot).not.toHaveBeenCalled();
    });

    it.each([
      // [targetDuration, rendition bitrate, measured throughput, expected margin]
      [6, 3e6, 6e6, 15],
      [2, 1e6, 1e8, 9],
      [10, 1e7, 1e6, 30],
    ])('measures the margin from the playlist (%s s segments)', async (target, bitrate, bw, margin) => {
      const { player } = await withBurned();
      const remove = vi.fn();
      player.techObj.vhs = {
        bandwidth: bw,
        masterPlaylistController_: {
          sourceUpdater_: { remove },
          mainPlaylistLoader_: { media: () => ({ targetDuration: target, attributes: { BANDWIDTH: bitrate } }) },
        },
      };
      player.s.duration = NaN;
      player.tick(30);
      q(player, '.vjs-banner-close').click();
      await flush();
      expect(remove).toHaveBeenCalledWith('video', 30 + margin, 30 + margin + 600);
    });

    it('a playlist that throws falls back to the generous margin', async () => {
      const { player } = await withBurned();
      const remove = vi.fn();
      player.techObj.vhs = {
        playlists: { media: () => { throw new Error('x'); } },
        playlistController_: { sourceUpdater_: { remove } },
      };
      player.s.duration = 200;
      player.tick(30);
      q(player, '.vjs-banner-close').click();
      await flush();
      expect(remove).toHaveBeenCalledWith('video', 45, 200);
    });

    it('retires a spot that has already passed', async () => {
      const { player, ab } = await withBurned();
      ab.endOfBreak.mockReturnValue(20);
      player.tick(30);
      q(player, '.vjs-banner-close').click();
      await flush();
      expect(ab.retireSpot).toHaveBeenCalled();
    });

    it('without VHS it reloads the source and resumes where it was after the seek', async () => {
      const { player } = await withBurned();
      player.s.source = { src: STITCHED, type: 'application/x-mpegURL' };
      player.s.paused = false;
      player.tick(30);
      q(player, '.vjs-banner-close').click();
      await flush();
      expect(player.src).toHaveBeenLastCalledWith({ src: STITCHED, type: 'application/x-mpegURL' });
      player.s.paused = true;
      player.play.mockClear();
      player.trigger('loadedmetadata');
      expect(player.currentTime).toHaveBeenLastCalledWith(30);
      player.trigger('seeked');
      expect(player.play).toHaveBeenCalledTimes(1);
    });

    it('resumes from the timeout when no seeked arrives, and a play rejection is fine', async () => {
      vi.useFakeTimers();
      const { player } = await withBurned();
      player.s.source = { src: STITCHED };
      player.s.paused = false;
      player.tick(30);
      q(player, '.vjs-banner-close').click();
      await flush();
      player.s.paused = true;
      player.playResults.push(new Error('interrupted'));
      player.trigger('loadedmetadata');
      vi.advanceTimersByTime(900);
      await flush();
      expect(player.play).toHaveBeenCalledTimes(1);
    });

    it('a paused viewer is not resumed, and a throwing seek is swallowed', async () => {
      vi.useFakeTimers();
      const { player } = await withBurned();
      player.s.source = { src: STITCHED };
      player.s.paused = true;
      player.tick(30);
      q(player, '.vjs-banner-close').click();
      await flush();
      player.trigger('loadedmetadata');
      vi.advanceTimersByTime(900);
      expect(player.play).not.toHaveBeenCalled();
      // Second reload path with a seek that throws.
      player.currentTime.mockImplementation((v) => { if (v !== undefined) throw new Error('x'); return 30; });
      q(player, '.vjs-banner-close').click();
      await flush();
      expect(() => player.trigger('loadedmetadata')).not.toThrow();
    });

    it('with no source to reload it gives up quietly', async () => {
      const { player } = await withBurned();
      player.s.source = null;
      player.tick(30);
      q(player, '.vjs-banner-close').click();
      await flush();
      expect(player.src).toHaveBeenCalledTimes(1);
    });

    it('with no clock it only tells the server', async () => {
      const { player, ab } = await withBurned();
      player.tick(30);
      player.s.currentTime = NaN;
      player.s.source = { src: STITCHED };
      q(player, '.vjs-banner-close').click();
      await flush();
      expect(ab.dismissBanner).toHaveBeenCalled();
      expect(player.src).toHaveBeenCalledTimes(1);
    });

    it('a failing dismissal lets the banner run its course', async () => {
      const { player, ab } = await withBurned();
      ab.dismissBanner.mockRejectedValue(new Error('offline'));
      player.tick(30);
      q(player, '.vjs-banner-close').click();
      await flush();
      expect(player.src).toHaveBeenCalledTimes(1);
    });
  });
});

describe('shadow copy for an instant close', () => {
  async function withShadow(opts = {}) {
    const ctx = await boot(opts);
    ctx.ab.bannerInfo = { brand: { clickUrl: 'https://checker.3speak.tv/c/burn1' } };
    ctx.ab.isBannerVisible.mockReturnValue(true);
    ctx.ab.bannerDueWithin.mockReturnValue(true);
    ctx.player.s.source = { src: STITCHED };
    ctx.player.s.paused = false;
    return ctx;
  }

  it('preloads the banner-free playlist ahead of the banner and follows the playhead', async () => {
    const { player, ab } = await withShadow();
    player.tick(30);
    expect(ab.bannerDueWithin).toHaveBeenCalledWith(30, 15);
    const shadow = q(player, 'video.vjs-shadow-clean');
    expect(shadow.muted).toBe(true);
    const h = hub.hlsInstances[0];
    expect(h.loadSource).toHaveBeenCalledWith(STITCHED + '?nobanner=1');
    expect(h.attachMedia).toHaveBeenCalledWith(shadow);
    shadow.play = vi.fn(() => Promise.reject(new Error('x')));
    h.handlers.hlsManifestParsed();
    expect(shadow.play).toHaveBeenCalled();
    // Same URL on the next tick: not rebuilt.
    player.tick(31);
    expect(hub.hlsInstances).toHaveLength(1);
  });

  it('a playlist URL with a query gets &nobanner=1, and a new URL replaces the shadow', async () => {
    const { player } = await withShadow();
    player.s.source = { src: STITCHED + '?sid=1' };
    player.tick(30);
    expect(hub.hlsInstances[0].loadSource).toHaveBeenCalledWith(STITCHED + '?sid=1&nobanner=1');
    player.s.source = { src: STITCHED + '?sid=2' };
    player.tick(31);
    expect(hub.hlsInstances[0].destroy).toHaveBeenCalled();
    expect(player.el().querySelectorAll('.vjs-shadow-clean')).toHaveLength(1);
  });

  it('is torn down once the banner window has passed', async () => {
    const { player, ab } = await withShadow();
    player.tick(30);
    ab.bannerDueWithin.mockReturnValue(false);
    player.tick(90);
    expect(hub.hlsInstances[0].destroy).toHaveBeenCalled();
    expect(q(player, '.vjs-shadow-clean')).toBeNull();
  });

  it('is never built on a phone, without MSE, for a plain source or a drawn banner', async () => {
    const phone = await withShadow({ ua: 'Mozilla/5.0 (Linux; Android 14) Mobile' });
    phone.player.tick(30);
    expect(q(phone.player, '.vjs-shadow-clean')).toBeNull();

    const touch = await withShadow({ maxTouchPoints: 5 });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    touch.player.tick(30);
    expect(q(touch.player, '.vjs-shadow-clean')).toBeNull();

    const noMse = await withShadow({ setup: (h) => { h.hlsSupported = false; } });
    noMse.player.tick(30);
    expect(q(noMse.player, '.vjs-shadow-clean')).toBeNull();

    const plain = await withShadow();
    plain.player.s.source = { src: 'https://play.3speak.tv/hls/badadib/xyz/manifest.m3u8' };
    plain.player.tick(30);
    plain.player.s.source = null;
    plain.player.tick(31);
    plain.player.currentSource.mockImplementation(() => { throw new Error('x'); });
    plain.player.tick(32);
    expect(hub.hlsInstances).toHaveLength(0);

    const drawn = await withShadow();
    drawn.ab.bannerOverlay = { imageUrl: 'https://img/x.png' };
    drawn.player.tick(30);
    expect(q(drawn.player, '.vjs-shadow-clean')).toBeNull();
  });

  it('a device check that throws counts as a desktop', async () => {
    const { player } = await withShadow();
    vi.stubGlobal('matchMedia', () => { throw new Error('x'); });
    player.tick(30);
    expect(q(player, '.vjs-shadow-clean')).not.toBeNull();
  });

  it('hls.js throwing while starting removes the half-built shadow', async () => {
    const { player } = await withShadow({ setup: (h) => { h.hlsThrows = true; } });
    player.tick(30);
    expect(q(player, '.vjs-shadow-clean')).toBeNull();
  });

  it('a manifest callback that throws is caught', async () => {
    const { player } = await withShadow();
    player.tick(30);
    const shadow = q(player, '.vjs-shadow-clean');
    shadow.play = () => { throw new Error('x'); };
    expect(() => hub.hlsInstances[0].handlers.hlsManifestParsed()).not.toThrow();
  });

  function makeReady(shadow, end) {
    Object.defineProperty(shadow, 'readyState', { configurable: true, value: 4 });
    Object.defineProperty(shadow, 'buffered', { configurable: true, value: { length: 1, end: () => end } });
    shadow.play = vi.fn(() => Promise.resolve());
  }

  it('closing swaps to the buffered copy at once and keeps it alive', async () => {
    const { player, ab } = await withShadow();
    player.s.muted = true;
    player.s.volume = 0.3;
    player.tick(30);
    const shadow = q(player, '.vjs-shadow-clean');
    makeReady(shadow, 40);
    q(player, '.vjs-banner-close').click();
    expect(shadow.classList.contains('vjs-shadow-live')).toBe(true);
    expect(shadow.muted).toBe(true);
    expect(shadow.volume).toBe(0.3);
    expect(player.pause).toHaveBeenCalled();
    expect(player.el().classList.contains('vjs-hidden-under-shadow')).toBe(true);
    expect(shadow.play).toHaveBeenCalled();
    expect(ab.dismissBanner).toHaveBeenCalledTimes(1);
    // The banner is gone now; the claimed shadow must survive the next ticks.
    ab.bannerDueWithin.mockReturnValue(false);
    player.tick(31);
    expect(shadow.isConnected).toBe(true);
    expect(hub.hlsInstances[0].destroy).not.toHaveBeenCalled();
  });

  it('a paused viewer stays paused on the swap, and a throwing dismissal is ignored', async () => {
    const { player, ab } = await withShadow();
    player.tick(30);
    const shadow = q(player, '.vjs-shadow-clean');
    makeReady(shadow, 40);
    player.s.paused = true;
    ab.dismissBanner.mockImplementation(() => { throw new Error('x'); });
    q(player, '.vjs-banner-close').click();
    await flush();
    expect(shadow.classList.contains('vjs-shadow-live')).toBe(true);
    expect(shadow.play).not.toHaveBeenCalled();
  });

  it('a copy that has not buffered far enough is not used', async () => {
    const { player, ab } = await withShadow();
    player.tick(30);
    const shadow = q(player, '.vjs-shadow-clean');
    makeReady(shadow, 31);
    q(player, '.vjs-banner-close').click();
    await flush();
    expect(shadow.classList.contains('vjs-shadow-live')).toBe(false);
    expect(ab.dismissBanner).toHaveBeenCalledTimes(1);
  });

  it('a swap that throws falls back to the slow path', async () => {
    const { player } = await withShadow();
    player.tick(30);
    const shadow = q(player, '.vjs-shadow-clean');
    makeReady(shadow, 40);
    Object.defineProperty(shadow, 'currentTime', { configurable: true, set() { throw new Error('x'); } });
    q(player, '.vjs-banner-close').click();
    await flush();
    expect(shadow.classList.contains('vjs-shadow-live')).toBe(false);
    expect(player.src).toHaveBeenLastCalledWith({ src: STITCHED });
  });
});
