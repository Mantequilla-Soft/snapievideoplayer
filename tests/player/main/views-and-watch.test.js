import './_helpers/mocks.js';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { boot, cleanup, flush, calls, bodyOf, videoFixture, stubProp } from './_helpers/boot.js';

beforeEach(() => { vi.useFakeTimers({ now: 10_000_000 }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function playing(opts) {
  const ctx = await boot(opts);
  ctx.player.s.paused = false;
  ctx.player.trigger('play');
  await flush();
  return ctx;
}

describe('view counter', () => {
  it('counts one view on the first play only', async () => {
    const { player, fetch } = await playing();
    player.trigger('play');
    await flush();
    const views = calls(fetch, '/api/view');
    expect(views).toHaveLength(1);
    expect(views[0][1].method).toBe('POST');
    expect(bodyOf(views[0])).toEqual({ owner: 'badadib', permlink: 'xyz', type: 'embed' });
    expect(player.hasIncrementedView).toBe(true);
  });

  it('a failing view request is logged, not thrown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await playing({ routes: { '/api/view': new Error('offline') } });
    expect(err).toHaveBeenCalledWith('Error incrementing view count:', expect.any(Error));
  });

  it('a refused view (not ok) is quiet', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetch } = await playing({ routes: { '/api/view': { status: 500, body: {} } } });
    expect(calls(fetch, '/api/view')).toHaveLength(1);
    expect(err).not.toHaveBeenCalled();
  });
});

describe('watch session', () => {
  it('opens one session on first play with the stored duration', async () => {
    const { player, fetch } = await playing();
    player.trigger('play');
    await flush();
    const starts = calls(fetch, '/api/watch/start');
    expect(starts).toHaveLength(1);
    expect(bodyOf(starts[0])).toEqual({
      owner: 'badadib', permlink: 'xyz', type: 'embed', duration: 120, position: 0,
      source: 'player', premium: false, private: false,
    });
    expect(player.watch).toMatchObject({ sid: 'sid-badadib', token: 'tok-1', beatMs: 5000, starting: false });
  });

  it('carries the partner token, the private flag and the premium flag', async () => {
    const { fetch } = await playing({
      url: '/embed?v=badadib/xyz&vt=abc.def&private=TRUE',
      setup: (h) => { h.adBreak.isPremiumViewer = true; },
    });
    expect(bodyOf(calls(fetch, '/api/watch/start')[0])).toMatchObject({
      viewerToken: 'abc.def', private: true, premium: true,
    });
  });

  it('an over-long partner token is dropped', async () => {
    const { fetch } = await playing({ url: '/embed?v=badadib/xyz&vt=' + 'a'.repeat(1100) });
    expect(bodyOf(calls(fetch, '/api/watch/start')[0]).viewerToken).toBeUndefined();
  });

  it('reports the position in content time when a spot is stitched in', async () => {
    const { fetch } = await playing({
      setup: (h) => {
        h.adBreak.active = true;
        h.adBreak.contentTime.mockImplementation((t) => Math.max(0, t - 15));
      },
    });
    expect(bodyOf(calls(fetch, '/api/watch/start')[0]).position).toBe(0);
  });

  it('without a stored duration waits for a stable reading', async () => {
    const { player, fetch } = await boot({ video: videoFixture({ duration: 0 }) });
    player.s.duration = 88;
    player.trigger('play');
    await flush();
    expect(calls(fetch, '/api/watch/start')).toHaveLength(0);
    player.trigger('durationchange');
    await flush();
    expect(bodyOf(calls(fetch, '/api/watch/start')[0]).duration).toBe(88);
  });

  it('a live duration that never settles is taken after the timeout', async () => {
    const { player, fetch } = await boot({ video: videoFixture({ duration: null }) });
    player.s.duration = 50;
    player.trigger('play');
    await flush();
    player.s.duration = NaN;
    player.trigger('durationchange'); // ignored
    player.s.duration = 70;
    player.trigger('durationchange'); // new baseline
    await flush();
    expect(calls(fetch, '/api/watch/start')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    expect(bodyOf(calls(fetch, '/api/watch/start')[0]).duration).toBe(70);
  });

  it('with no duration at all the session opens without one', async () => {
    const { fetch } = await playing({ video: videoFixture({ duration: 0 }) });
    expect(bodyOf(calls(fetch, '/api/watch/start')[0]).duration).toBeUndefined();
  });

  it('no session for a video without owner/permlink', async () => {
    const { fetch, player } = await playing({ video: videoFixture({ permlink: '' }) });
    expect(calls(fetch, '/api/watch/start')).toHaveLength(0);
    expect(player.watch).toBeNull();
  });

  it('beats once per interval while playing, with the server-chosen interval', async () => {
    const { player, fetch } = await playing({
      routes: { '/api/watch/start': { body: { sid: 's2', token: 't2', beatSeconds: 10 } } },
    });
    player.s.playbackRate = 1.5;
    vi.advanceTimersByTime(9999);
    player.tick(10);
    expect(calls(fetch, '/api/watch/beat')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    player.tick(10.25);
    const beats = calls(fetch, '/api/watch/beat');
    expect(beats).toHaveLength(1);
    expect(beats[0][1].keepalive).toBe(true);
    expect(bodyOf(beats[0])).toEqual({ sid: 's2', token: 't2', position: 10.25, rate: 1.5, hidden: false });
    player.tick(10.5);
    expect(calls(fetch, '/api/watch/beat')).toHaveLength(1);
  });

  it('sends a final beat on pause and on ended', async () => {
    const { player, fetch } = await playing();
    player.s.currentTime = 7;
    player.trigger('pause');
    player.trigger('ended');
    expect(calls(fetch, '/api/watch/beat').map((c) => bodyOf(c).position)).toEqual([7, 7]);
  });

  it('flushes with sendBeacon when the tab is hidden or closed', async () => {
    const beacon = vi.fn(() => true);
    const { player } = await playing();
    stubProp(navigator, 'sendBeacon', beacon);
    vi.stubGlobal('Blob', class { constructor(parts, o) { this.parts = parts; this.type = o.type; } });
    player.s.currentTime = 3;
    stubProp(document, 'visibilityState', 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0];
    expect(url).toBe('/api/watch/beat');
    expect(blob.type).toBe('application/json');
    expect(JSON.parse(blob.parts[0])).toMatchObject({ sid: 'sid-badadib', position: 3, hidden: true });
    window.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(2);
  });

  it('a visible tab does not flush, and nothing flushes before a session', async () => {
    const beacon = vi.fn(() => true);
    await boot();
    stubProp(navigator, 'sendBeacon', beacon);
    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(beacon).not.toHaveBeenCalled();
  });

  it('falls back to fetch when sendBeacon is missing', async () => {
    const { fetch } = await playing();
    stubProp(navigator, 'sendBeacon', undefined);
    window.dispatchEvent(new Event('pagehide'));
    expect(calls(fetch, '/api/watch/beat')).toHaveLength(1);
  });

  it('a failing beat never breaks playback', async () => {
    const { player } = await playing({ routes: { '/api/watch/beat': new Error('offline') } });
    expect(() => player.trigger('pause')).not.toThrow();
    await flush();
  });

  it('no beats when the server does not track the video', async () => {
    const { player, fetch } = await playing({ routes: { '/api/watch/start': { body: { tracked: false } } } });
    vi.advanceTimersByTime(6000);
    player.tick(6);
    player.trigger('pause');
    expect(calls(fetch, '/api/watch/beat')).toHaveLength(0);
    expect(player.watch.sid).toBeNull();
  });

  it('no beats when the start is refused or fails', async () => {
    const a = await playing({ routes: { '/api/watch/start': { status: 503, body: {} } } });
    a.player.trigger('pause');
    expect(calls(a.fetch, '/api/watch/beat')).toHaveLength(0);
    const b = await playing({ routes: { '/api/watch/start': new Error('offline') } });
    b.player.trigger('pause');
    expect(calls(b.fetch, '/api/watch/beat')).toHaveLength(0);
    expect(b.player.watch.starting).toBe(false);
  });

  it('a session answer arriving after a new video loaded is dropped', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { player, mod } = await boot({
      routes: { '/api/watch/start': async () => { await gate; return { body: { sid: 'late', token: 'x' } }; } },
    });
    player.trigger('play');
    await flush();
    await mod.loadVideoFromData(videoFixture({ permlink: 'other' }));
    release();
    await flush();
    expect(player.watch).toBeNull();
  });
});

describe('ad resolve on play', () => {
  it('asks where the cut landed when a spot is active but unresolved', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ab } = await playing({
      url: '/embed?v=badadib/xyz&debug=1',
      setup: (h) => { h.adBreak.active = true; h.adBreak.resolve.mockResolvedValue({ start: 30 }); },
    });
    expect(ab.resolve).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('[3Speak Debug]', 'Sponsor break at', { start: 30 });
  });

  it('does not ask again once resolved', async () => {
    const { ab } = await playing({ setup: (h) => { h.adBreak.active = true; h.adBreak.resolved = true; } });
    expect(ab.resolve).not.toHaveBeenCalled();
  });
});

describe('duration self-heal (embeds)', () => {
  const heals = (fetch) => calls(fetch, '/api/duration').map((c) => bodyOf(c));

  it('fills in a missing stored duration from the first reading', async () => {
    const { player, fetch } = await boot({ video: videoFixture({ duration: 0 }) });
    player.s.duration = 100;
    player.trigger('play');
    await flush();
    expect(heals(fetch)).toEqual([{ owner: 'badadib', permlink: 'xyz', duration: 100 }]);
    expect(player.hasHealedDuration).toBe(true);
    player.trigger('play');
    await flush();
    expect(heals(fetch)).toHaveLength(1);
  });

  it('grows a stored duration that is too short', async () => {
    const { player, fetch } = await boot();
    player.s.duration = 150;
    player.trigger('play');
    await flush();
    expect(heals(fetch)).toEqual([expect.objectContaining({ duration: 150 })]);
  });

  it('leaves a stored duration within a second alone', async () => {
    const { player, fetch } = await boot();
    player.s.duration = 120.6;
    player.trigger('play');
    await flush();
    expect(heals(fetch)).toEqual([]);
    expect(player.hasHealedDuration).toBe(true);
  });

  it('a transient short reading that settles back is not written', async () => {
    const { player, fetch } = await boot();
    player.s.duration = 6;
    player.trigger('play');
    await flush();
    player.s.duration = 120;
    player.trigger('durationchange');
    player.trigger('durationchange');
    await flush();
    expect(heals(fetch)).toEqual([]);
    expect(player.hasHealedDuration).toBe(true);
  });

  it('a short reading that stays short is written after it settles', async () => {
    const { player, fetch } = await boot();
    player.s.duration = 60;
    player.trigger('play');
    await flush();
    expect(heals(fetch)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    await flush();
    expect(heals(fetch)).toEqual([expect.objectContaining({ duration: 60 })]);
  });

  it('a shrinking reading confirmed by a durationchange is written', async () => {
    const { player, fetch } = await boot();
    player.s.duration = 60;
    player.trigger('play');
    await flush();
    player.trigger('durationchange');
    await flush();
    expect(heals(fetch)).toEqual([expect.objectContaining({ duration: 60 })]);
  });

  it('no reading yet means no heal and a retry on the next play', async () => {
    const { player, fetch } = await boot();
    player.trigger('play');
    await flush();
    expect(heals(fetch)).toEqual([]);
    expect(player.hasHealedDuration).toBe(false);
  });

  it('never on a legacy video', async () => {
    const { player, fetch } = await boot({ url: '/watch?v=badadib/xyz', video: videoFixture({ type: 'legacy', duration: 0 }) });
    player.s.duration = 100;
    player.trigger('play');
    await flush();
    expect(heals(fetch)).toEqual([]);
  });

  it('a failed heal is logged; a refused one is quiet', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = await boot({ video: videoFixture({ duration: 0 }), routes: { '/api/duration': new Error('offline') } });
    a.player.s.duration = 100;
    a.player.trigger('play');
    await flush();
    expect(err).toHaveBeenCalledWith('Error healing duration:', expect.any(Error));
    err.mockClear();
    const b = await boot({ video: videoFixture({ duration: 0 }), routes: { '/api/duration': { body: { success: false } } } });
    b.player.s.duration = 100;
    b.player.trigger('play');
    await flush();
    const c = await boot({ video: videoFixture({ duration: 0 }), routes: { '/api/duration': { status: 500, body: {} } } });
    c.player.s.duration = 100;
    c.player.trigger('play');
    await flush();
    expect(err).not.toHaveBeenCalled();
  });
});
