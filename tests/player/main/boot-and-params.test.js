import './_helpers/mocks.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { boot, calls, cleanup, flush, videoFixture, hub, VIDEO_URL, FALLBACK_URL } from './_helpers/boot.js';

afterEach(() => cleanup());

describe('boot: route and URL parameters', () => {
  it('an /embed URL fetches /api/embed and loads the video into the player', async () => {
    const { player, fetch } = await boot({ url: '/embed?v=badadib/xyz' });
    expect(calls(fetch, '/api/embed')[0][0]).toBe('/api/embed?v=badadib/xyz');
    expect(calls(fetch, '/api/watch')).toHaveLength(0);
    expect(hub.videojsCalls[0].id).toBe('snapie-player');
    expect(player.src).toHaveBeenCalledWith([{ src: VIDEO_URL, type: 'application/x-mpegURL' }]);
    expect(player.load).toHaveBeenCalled();
    expect(player.poster).toHaveBeenCalledWith('https://images.3speak.tv/badadib/xyz.jpg');
    expect(document.getElementById('current-source').textContent).toBe('Badadib test video');
    expect(document.getElementById('view-count').textContent).toBe((1234).toLocaleString());
    expect(document.getElementById('player-state').textContent).toBe('Ready');
    expect(hub.tip).toHaveBeenCalledWith(player, expect.objectContaining({ owner: 'badadib', permlink: 'xyz' }));
    expect(hub.scrub.setSource).toHaveBeenCalledWith(VIDEO_URL);
    expect(hub.heatmap.setVideo).toHaveBeenCalledWith('badadib', 'xyz', 'embed');
    expect(hub.subtitle.init).toHaveBeenCalledWith(expect.any(Function));
    expect(hub.caption.init).toHaveBeenCalledWith(player);
    expect(hub.subtitle.checkAvailability).toHaveBeenCalledWith('badadib', 'xyz');
    expect(hub.scrub.setLabel).toHaveBeenCalled();
    // The scrub preview labels come from the timeline's chapter names.
    expect(hub.scrub.setLabel.mock.calls[0][0](0.5)).toBe('Chapter');
    expect(hub.timeline.chapterLabel).toHaveBeenCalledWith(0.5);
  });

  it('a /watch URL asks /api/watch', async () => {
    const { fetch } = await boot({ url: '/watch?v=badadib/xyz', iframe: false });
    expect(calls(fetch, '/api/watch')[0][0]).toBe('/api/watch?v=badadib/xyz');
    expect(calls(fetch, '/api/embed')).toHaveLength(0);
  });

  it('/play is an embed that does not count a view but still tracks the watch', async () => {
    const { player, fetch } = await boot({ url: '/play?v=badadib/xyz' });
    expect(calls(fetch, '/api/embed')).toHaveLength(1);
    player.trigger('play');
    await flush();
    expect(calls(fetch, '/api/view')).toHaveLength(0);
    expect(calls(fetch, '/api/watch/start')).toHaveLength(1);
  });

  it('/play?type=legacy reads /api/watch', async () => {
    const { fetch } = await boot({ url: '/play?v=badadib/xyz&type=legacy' });
    expect(calls(fetch, '/api/watch')).toHaveLength(1);
  });

  it('?noview=yes on an embed skips the view counter', async () => {
    const { player, fetch } = await boot({ url: '/embed?v=badadib/xyz&noview=YES' });
    player.trigger('play');
    await flush();
    expect(calls(fetch, '/api/view')).toHaveLength(0);
    expect(calls(fetch, '/api/watch/start')).toHaveLength(1);
  });

  it('mode=iframe without a layout fills the frame and is not fluid', async () => {
    await boot({ url: '/embed?v=badadib/xyz&mode=iframe' });
    expect(document.body.classList.contains('iframe-mode')).toBe(true);
    expect(document.documentElement.classList.contains('iframe-mode')).toBe(true);
    expect(document.body.classList.contains('layout-fill')).toBe(true);
    const o = hub.videojsCalls[0].options;
    expect(o.fluid).toBe(false);
    expect(o.responsive).toBe(false);
  });

  it('an explicit layout wins over the iframe default', async () => {
    await boot({ url: '/embed?v=badadib/xyz&mode=iframe&layout=mobile' });
    expect(document.body.classList.contains('layout-mobile')).toBe(true);
    expect(document.body.classList.contains('layout-fill')).toBe(false);
    expect(hub.videojsCalls[0].options.fluid).toBe(false);
  });

  it('a standalone page with no layout is fluid and responsive', async () => {
    await boot({ url: '/watch?v=badadib/xyz', iframe: false });
    expect(document.body.className).toBe('');
    const o = hub.videojsCalls[0].options;
    expect(o.fluid).toBe(true);
    expect(o.responsive).toBe(true);
    expect(o.controls).toBe(true);
    expect(o.muted).toBe(false);
    expect(o.userActions.hotkeys).toBe(true);
  });

  it('noscroll=1 hides the scrollbars', async () => {
    await boot({ url: '/embed?v=badadib/xyz&noscroll=1' });
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('controls=0 drops the controls, the scrub preview and the heatmap', async () => {
    await boot({ url: '/embed?v=badadib/xyz&controls=0' });
    expect(hub.videojsCalls[0].options.controls).toBe(false);
    expect(hub.scrub).toBeNull();
    expect(hub.heatmap).toBeNull();
    // The timeline still exists: link toasters work without controls.
    expect(hub.timeline).not.toBeNull();
  });

  it('preview=0 and heatmap=no turn those two off individually', async () => {
    await boot({ url: '/embed?v=badadib/xyz&preview=0&heatmap=no' });
    expect(hub.videojsCalls[0].options.controls).toBe(true);
    expect(hub.scrub).toBeNull();
    expect(hub.heatmap).toBeNull();
  });

  it('captions=false skips the subtitle manager entirely', async () => {
    await boot({ url: '/embed?v=badadib/xyz&captions=false' });
    expect(hub.subtitle.init).not.toHaveBeenCalled();
    expect(hub.caption.init).not.toHaveBeenCalled();
    expect(hub.subtitle.checkAvailability).not.toHaveBeenCalled();
  });

  it('mute=1 and loop=true reach the player', async () => {
    const { player } = await boot({ url: '/embed?v=badadib/xyz&mute=1&loop=true' });
    expect(hub.videojsCalls[0].options.muted).toBe(true);
    expect(player.loop).toHaveBeenCalledWith(true);
  });

  it('without loop the player is not looped', async () => {
    const { player } = await boot();
    expect(player.loop).not.toHaveBeenCalled();
    expect(player.hlsQualitySelector).toHaveBeenCalledWith({ displayCurrentQuality: true });
  });

  it('registers the two quality plugins once', async () => {
    await boot();
    expect(Object.keys(hub.plugins).sort()).toEqual(['hlsQualitySelector', 'qualityLevels']);
  });

  it('several distinct fallbacks are queued behind the primary in order', async () => {
    const { player } = await boot({
      video: videoFixture({
        videoUrlFallback1: FALLBACK_URL,
        videoUrlFallback2: 'https://hotnode.3speak.tv/badadib/manifest.m3u8',
        videoUrlFallback3: 'https://audionode.3speak.tv/badadib/manifest.m3u8',
      }),
    });
    expect(player.src.mock.calls[0][0].map((s) => s.src)).toEqual([
      VIDEO_URL, FALLBACK_URL,
      'https://hotnode.3speak.tv/badadib/manifest.m3u8',
      'https://audionode.3speak.tv/badadib/manifest.m3u8',
    ]);
  });

  it('a title-less video is labelled owner/permlink and zero views show a dash', async () => {
    await boot({ video: videoFixture({ title: '', views: 0, thumbnail: null }) });
    expect(document.getElementById('current-source').textContent).toBe('badadib/xyz');
    expect(document.getElementById('view-count').textContent).toBe('-');
    expect(hub.player.poster).not.toHaveBeenCalled();
  });

  it('a placeholder video says so in the state line and never asks for an ad', async () => {
    const { ab } = await boot({ video: videoFixture({ isPlaceholder: true, status: 'processing' }) });
    expect(document.getElementById('player-state').textContent).toBe('Placeholder (processing)');
    expect(ab.request).not.toHaveBeenCalled();
  });

  it('?strict=1 is passed to the API and never asks for an ad', async () => {
    const { fetch, ab } = await boot({ url: '/embed?v=badadib/xyz&strict=1', video: videoFixture({ strict: true }) });
    expect(calls(fetch, '/api/embed')[0][0]).toBe('/api/embed?v=badadib/xyz&strict=1');
    expect(ab.request).not.toHaveBeenCalled();
  });

  it('?strict=1 the server cannot honour (a plain IPFS video): still no ad', async () => {
    const { ab } = await boot({ url: '/watch?v=badadib/xyz&strict=1', iframe: false, video: videoFixture({ strict: false }) });
    expect(ab.request).not.toHaveBeenCalled();
  });

  it('strict only as exactly 1', async () => {
    const { fetch, ab } = await boot({ url: '/embed?v=badadib/xyz&strict=true' });
    expect(calls(fetch, '/api/embed')[0][0]).toBe('/api/embed?v=badadib/xyz');
    expect(ab.request).toHaveBeenCalled();
  });

  it('a short never asks for an ad', async () => {
    const { ab } = await boot({ video: videoFixture({ short: true }) });
    expect(ab.request).not.toHaveBeenCalled();
  });
});

describe('boot: sponsor request', () => {
  it('asks for a spot with the drawn banner and the ticker enabled', async () => {
    const { ab } = await boot({ url: '/embed?v=badadib/xyz&viewer=BadAdib' });
    expect(ab.reset).toHaveBeenCalled();
    expect(ab.request).toHaveBeenCalledWith({
      owner: 'badadib', permlink: 'xyz', viewer: 'badadib',
      manifestUrl: VIDEO_URL, bannerOverlay: true, ticker: true,
    });
  });

  it('a stitched manifest plays first with the original right behind it', async () => {
    const stitched = 'https://checker.3speak.tv/m/sess1/manifest.m3u8';
    const { player } = await boot({ setup: (h) => { h.adBreak.request.mockResolvedValue(stitched); } });
    expect(player.src.mock.calls[0][0].map((s) => s.src)).toEqual([stitched, VIDEO_URL]);
    // The scrub preview keeps the clean original.
    expect(hub.scrub.setSource).toHaveBeenCalledWith(VIDEO_URL);
  });

  it('a failing ad request still plays the plain video', async () => {
    const { player } = await boot({ setup: (h) => { h.adBreak.request.mockRejectedValue(new Error('down')); } });
    expect(player.src.mock.calls[0][0]).toEqual([{ src: VIDEO_URL, type: 'application/x-mpegURL' }]);
  });

  it('an invalid viewer name is not sent', async () => {
    const { ab } = await boot({ url: '/embed?v=badadib/xyz&viewer=x!' });
    expect(ab.request.mock.calls[0][0].viewer).toBeNull();
  });

  it('falls back to the account named inside a partner token', async () => {
    const payload = btoa(JSON.stringify({ v: 'BADADIB', app: 'snapie' })).replace(/=+$/, '');
    const { ab } = await boot({ url: `/embed?v=badadib/xyz&vt=${payload}.sig` });
    expect(ab.request.mock.calls[0][0].viewer).toBe('badadib');
  });

  it('ignores a partner token whose claims are unusable', async () => {
    const bad = btoa(JSON.stringify({ v: '!!' }));
    const { ab } = await boot({ url: `/embed?v=badadib/xyz&vt=${bad}.sig` });
    expect(ab.request.mock.calls[0][0].viewer).toBeNull();
    const { ab: ab2 } = await boot({ url: '/embed?v=badadib/xyz&vt=.onlysig' });
    expect(ab2.request.mock.calls[0][0].viewer).toBeNull();
    const { ab: ab3 } = await boot({ url: '/embed?v=badadib/xyz&vt=%%%%.sig' });
    expect(ab3.request.mock.calls[0][0].viewer).toBeNull();
  });
});

describe('boot: debug mode and init failures', () => {
  it('debug=1 logs and exposes the ad debug hook', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ab, player } = await boot({ url: '/embed?v=badadib/xyz&debug=1' });
    expect(window.__3sAdDebug.adBreak).toBe(ab);
    expect(typeof window.__3sAdDebug.updateSponsorLabel).toBe('function');
    expect(log.mock.calls.some((c) => c[0] === '[3Speak Debug]')).toBe(true);
    // loadedmetadata measures the tech element in debug mode.
    log.mockClear();
    player.trigger('loadedmetadata');
    expect(log.mock.calls.some((c) => c[1] === 'vjs-tech styles after loadedmetadata')).toBe(true);
    // And says so when there is no tech element.
    player.el_.querySelector('.vjs-tech').remove();
    log.mockClear();
    player.trigger('loadedmetadata');
    expect(log.mock.calls.some((c) => c[1] === 'vjs-tech element not found after loadedmetadata')).toBe(true);
  });

  it('without debug nothing is logged or exposed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boot();
    expect(window.__3sAdDebug).toBeUndefined();
    expect(log.mock.calls.some((c) => c[0] === '[3Speak Debug]')).toBe(false);
  });

  it('a broken scrub preview, heatmap or timeline only warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { player } = await boot({ setup: (h) => { h.scrubThrows = true; h.heatmapThrows = true; h.timelineThrows = true; } });
    const msgs = warn.mock.calls.map((c) => c[0]);
    expect(msgs).toEqual(expect.arrayContaining([
      'Scrub preview init failed:', 'Heatmap init failed:', 'Timeline UI init failed:',
    ]));
    expect(player.src).toHaveBeenCalled();
  });

  it('loadVideoFromData before the player exists refuses', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    const mod = await import('../../../src/main.js');
    await mod.loadVideoFromData(videoFixture());
    expect(err).toHaveBeenCalledWith('Player not initialized');
  });

  it('an exception while loading the video shows the error card', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await boot({ setup: (h) => { h.tip = vi.fn(() => { throw new Error('tip broke'); }); } });
    const msg = document.querySelector('.player-message');
    expect(msg.textContent).toContain('tip broke');
    expect(msg.textContent).toContain('badadib/xyz');
  });
});

describe('boot: platform detection', () => {
  it('a Mac gets the conservative buffer and VHS still handles HLS', async () => {
    await boot({ platform: 'MacIntel', maxTouchPoints: 0, ua: 'Mozilla/5.0 (Macintosh) Firefox/130' });
    const { hls, vhs } = hub.videojsCalls[0].options.html5;
    expect(vhs.maxBufferLength).toBe(20);
    expect(hls.maxBufferSize).toBe(20 * 1000 * 1000);
    expect(vhs.overrideNative).toBe(true);
  });

  it('an iPad (Mac with touch) hands HLS to the native player', async () => {
    await boot({ platform: 'MacIntel', maxTouchPoints: 5 });
    const { hls, vhs } = hub.videojsCalls[0].options.html5;
    expect(vhs.overrideNative).toBe(false);
    expect(hls.overrideNative).toBe(false);
  });

  it('Linux gets the larger buffer and VHS', async () => {
    await boot({ platform: 'Linux x86_64', ua: 'Mozilla/5.0 (X11; Linux) Firefox/130' });
    const { vhs } = hub.videojsCalls[0].options.html5;
    expect(vhs.maxBufferLength).toBe(30);
    expect(vhs.bandwidth).toBe(5000000);
    expect(vhs.overrideNative).toBe(true);
  });

  it('tvmode=1 disables the video.js hotkeys and Enter toggles fullscreen', async () => {
    const { player } = await boot({ url: '/embed?v=badadib/xyz&tvmode=1' });
    expect(hub.videojsCalls[0].options.userActions.hotkeys).toBe(false);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(player.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(player.exitFullscreen).toHaveBeenCalledTimes(1);
    // Other keys are left alone.
    const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    document.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it('without tvmode Enter does nothing', async () => {
    const { player } = await boot();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(player.requestFullscreen).not.toHaveBeenCalled();
  });
});
