import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requireFresh } from './_helpers/load.js';

const hg = requireFresh('hlsGateways.js');
const { createSegmentRouter, isSegmentUrl, isPlaylistUrl, segmentRouteUrl, gatewayOf, FALLBACK_GATEWAYS, SEGMENT_HOSTS } = hg;

const CID = 'QmSK7j5YJfzdKRcziM8wCzKeL4gggW4QJL9fy4GkWc7yKB';
const BCDN = 'https://ipfs-3speak.b-cdn.net';
const HOT = 'https://hotipfs-3speak-1.b-cdn.net';
const AUDIO = 'https://ipfs-audio.3speak.tv';
const seg = (host, n) => `${host}/ipfs/${CID}/480p/480p_${n}.ts`;

const waitAbort = (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(new Error('aborted')));
});

/**
 * Fake fetch. Per URL: 'ok' (default), 'slow' (answers after slowMs), 'trickle'
 * (one chunk, then nothing), 'hang' (never answers), 'fail' (502), 'throw'
 * (network error), 'nobody' (ok, no body stream), 'badcancel' (cancel throws).
 */
function fakeFetch(answers = {}, { size = 64 * 1024, slowMs = 200, chunk = 1024 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, range: opts?.headers?.Range, redirect: opts?.redirect });
    const a = answers[url] || 'ok';
    if (a === 'hang') return waitAbort(opts.signal);
    if (a === 'throw') throw new Error('ECONNRESET');
    if (a === 'slow') await new Promise((r) => setTimeout(r, slowMs));
    if (a === 'fail') return { ok: false, status: 502 };
    if (a === 'nobody') return { ok: true, status: 206, body: null };
    let sent = 0;
    return {
      ok: true,
      status: 206,
      body: {
        getReader: () => ({
          read: () => {
            if (sent >= size) return Promise.resolve({ done: true });
            if (a === 'trickle' && sent > 0) return waitAbort(opts.signal);
            sent += chunk;
            return Promise.resolve({ done: false, value: a === 'emptychunk' ? undefined : new Uint8Array(chunk) });
          },
          cancel: async () => { if (a === 'badcancel') throw new Error('already closed'); },
        }),
      },
    };
  };
  fn.calls = calls;
  return fn;
}

/** Let pending promise chains run (setImmediate is faked too). */
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

/** Start a route() call and report whether it settled yet. */
function track(promise) {
  const t = { done: false, value: undefined };
  promise.then((v) => { t.done = true; t.value = v; });
  return t;
}

describe('url helpers', () => {
  it('lists the fallback and segment hosts', () => {
    expect(FALLBACK_GATEWAYS).toEqual([AUDIO]);
    expect([...SEGMENT_HOSTS].sort()).toEqual(['hotipfs-3speak-1.b-cdn.net', 'ipfs-3speak.b-cdn.net', 'ipfs-audio.3speak.tv']);
  });

  describe('isSegmentUrl', () => {
    it('accepts a file under a CID on one of the CORS gateways', () => {
      expect(isSegmentUrl(seg(BCDN, 0))).toBe(true);
      expect(isSegmentUrl(seg(HOT, 0))).toBe(true);
      expect(isSegmentUrl(seg(AUDIO, 0))).toBe(true);
    });

    it('rejects playlists, other hosts, plain http, bare CIDs and junk', () => {
      expect(isSegmentUrl(`${BCDN}/ipfs/${CID}/480p/index.m3u8`)).toBe(false);
      expect(isSegmentUrl(`${BCDN}/ipfs/${CID}/480p/index.m3u8?x=1`)).toBe(false);
      expect(isSegmentUrl(seg('https://ipfs.3speak.tv', 0))).toBe(false);
      expect(isSegmentUrl(`https://example.com/ipfs/${CID}/a.ts`)).toBe(false);
      expect(isSegmentUrl(seg('http://ipfs-3speak.b-cdn.net', 0))).toBe(false);
      expect(isSegmentUrl(`${BCDN}/ipfs/${CID}`)).toBe(false);
      expect(isSegmentUrl(`${BCDN}/ipns/${CID}/a.ts`)).toBe(false);
      expect(isSegmentUrl('not a url')).toBe(false);
      expect(isSegmentUrl(undefined)).toBe(false);
    });
  });

  it('isPlaylistUrl spots .m3u8 with or without a query', () => {
    expect(isPlaylistUrl('a/index.m3u8')).toBe(true);
    expect(isPlaylistUrl('a/INDEX.M3U8?token=1')).toBe(true);
    expect(isPlaylistUrl('a/b.ts')).toBe(false);
    expect(isPlaylistUrl('a/b.m3u8x')).toBe(false);
    expect(isPlaylistUrl(null)).toBe(false);
  });

  it('gatewayOf returns the https origin in front of /ipfs/', () => {
    expect(gatewayOf(seg(BCDN, 1))).toBe(BCDN);
    expect(gatewayOf('http://ipfs-3speak.b-cdn.net/ipfs/x/y')).toBeNull();
    expect(gatewayOf('https://example.com/other/x')).toBeNull();
    expect(gatewayOf(undefined)).toBeNull();
  });

  describe('segmentRouteUrl', () => {
    it('ends in the segment file name and carries the url encoded', () => {
      expect(segmentRouteUrl('https://play.3speak.tv', seg(BCDN, 2)))
        .toBe(`https://play.3speak.tv/seg/480p_2.ts?u=${encodeURIComponent(seg(BCDN, 2))}`);
    });

    it('makes odd characters in the name safe', () => {
      expect(segmentRouteUrl('https://p', `${BCDN}/ipfs/${CID}/a b"c.ts`).split('?')[0]).toBe('https://p/seg/a_b_c.ts');
      expect(segmentRouteUrl('https://p', `${BCDN}/ipfs/${CID}/%E2%9C%93.ts`).split('?')[0]).toBe('https://p/seg/_.ts');
    });

    it('keeps a name it cannot decode, made safe', () => {
      expect(segmentRouteUrl('https://p', `${BCDN}/ipfs/${CID}/bad%E0%A4.ts`).split('?')[0]).toBe('https://p/seg/bad_E0_A4.ts');
    });

    it('falls back to "segment" when the path ends in a slash', () => {
      expect(segmentRouteUrl('https://p', `${BCDN}/ipfs/${CID}/`).split('?')[0]).toBe('https://p/seg/segment');
    });
  });
});

describe('createSegmentRouter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const fast = { probeMs: 1500, hedgeMs: 700, fallbackProbeMs: 3000, probeBytes: 8 * 1024 };

  it('leaves a url that is not on an IPFS gateway alone, asking nobody', async () => {
    const f = fakeFetch();
    const route = createSegmentRouter({ fetchImpl: f });
    expect(await route('https://example.com/a.ts')).toBe('https://example.com/a.ts');
    expect(await route(seg(AUDIO, 7))).toBe(seg(AUDIO, 7));
    expect(f.calls).toEqual([]);
  });

  it('keeps a cached Bunny segment on Bunny, after reading the END of it', async () => {
    const f = fakeFetch();
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    expect(await route(seg(BCDN, 0))).toBe(seg(BCDN, 0));
    expect(f.calls).toEqual([{ url: seg(BCDN, 0), range: 'bytes=-8192', redirect: 'follow' }]);
  });

  it('remembers the answer for cacheMs, then asks again', async () => {
    const f = fakeFetch();
    const route = createSegmentRouter({ ...fast, fetchImpl: f, cacheMs: 1000 });
    await route(seg(BCDN, 0));
    await route(seg(BCDN, 0));
    expect(f.calls).toHaveLength(1);
    vi.advanceTimersByTime(1001);
    await route(seg(BCDN, 0));
    expect(f.calls).toHaveLength(2);
  });

  it('sends a hanging segment to ipfs-audio once Bunny runs out of time', async () => {
    const f = fakeFetch({ [seg(BCDN, 1)]: 'hang' });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    const t = track(route(seg(BCDN, 1)));
    await vi.advanceTimersByTimeAsync(699);
    expect(f.calls.map((c) => c.url)).toEqual([seg(BCDN, 1)]);
    await vi.advanceTimersByTimeAsync(1); // the hedge: ipfs-audio is asked in parallel
    await flush();
    expect(f.calls.map((c) => c.url)).toEqual([seg(BCDN, 1), seg(AUDIO, 1)]);
    expect(t.done).toBe(false); // Bunny still has until probeMs
    await vi.advanceTimersByTimeAsync(800);
    await flush();
    expect(t).toEqual({ done: true, value: seg(AUDIO, 1) });
  });

  it('treats a Bunny trickle (first bytes, then nothing) as a miss', async () => {
    const f = fakeFetch({ [seg(BCDN, 2)]: 'trickle' });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    const p = route(seg(BCDN, 2));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await p).toBe(seg(AUDIO, 2));
  });

  it('goes to ipfs-audio at once when Bunny errors or the request throws', async () => {
    const f = fakeFetch({ [seg(BCDN, 3)]: 'fail', [seg(BCDN, 4)]: 'throw' });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    expect(await route(seg(BCDN, 3))).toBe(seg(AUDIO, 3));
    expect(await route(seg(BCDN, 4))).toBe(seg(AUDIO, 4));
  });

  it('stays on a slow Bunny that passes within its limit, though ipfs-audio was asked', async () => {
    const f = fakeFetch({ [seg(BCDN, 5)]: 'slow' }, { slowMs: 1000 });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    const p = route(seg(BCDN, 5));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(seg(BCDN, 5));
    expect(f.calls.map((c) => c.url)).toEqual([seg(BCDN, 5), seg(AUDIO, 5)]);
  });

  it('never asks ipfs-audio when Bunny is fast', async () => {
    const f = fakeFetch();
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    await route(seg(BCDN, 6));
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls).toHaveLength(1);
  });

  it('when nobody answers: the original, remembered only for missCacheMs', async () => {
    const f = fakeFetch({ [seg(BCDN, 8)]: 'hang', [seg(AUDIO, 8)]: 'fail' });
    const route = createSegmentRouter({ ...fast, fetchImpl: f, missCacheMs: 1000, cacheMs: 60000 });
    const p = route(seg(BCDN, 8));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await p).toBe(seg(BCDN, 8));
    expect(await route(seg(BCDN, 8))).toBe(seg(BCDN, 8));
    expect(f.calls).toHaveLength(2);
    vi.advanceTimersByTime(1001);
    const again = route(seg(BCDN, 8));
    await vi.advanceTimersByTimeAsync(1500);
    await again;
    expect(f.calls).toHaveLength(4);
  });

  it('with both silent, waits hedge + fallback limit, not the sum of both limits', async () => {
    const f = fakeFetch({ [seg(BCDN, 9)]: 'hang', [seg(AUDIO, 9)]: 'hang' });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    const t = track(route(seg(BCDN, 9)));
    await vi.advanceTimersByTimeAsync(3699);
    await flush();
    expect(t.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(t).toEqual({ done: true, value: seg(BCDN, 9) });
  });

  it('shares one decision between concurrent requests for a segment', async () => {
    const f = fakeFetch({ [seg(BCDN, 10)]: 'slow' }, { slowMs: 50 });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    const all = Promise.all([route(seg(BCDN, 10)), route(seg(BCDN, 10)), route(seg(BCDN, 10))]);
    await vi.advanceTimersByTimeAsync(50);
    expect(await all).toEqual([seg(BCDN, 10), seg(BCDN, 10), seg(BCDN, 10)]);
    expect(f.calls).toHaveLength(1);
  });

  it('passes a segment smaller than the probe once it has all arrived', async () => {
    const f = fakeFetch({}, { size: 2 * 1024 });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    expect(await route(seg(BCDN, 11))).toBe(seg(BCDN, 11));
    expect(f.calls).toHaveLength(1);
  });

  it('passes on headers alone when there is no body stream to time', async () => {
    const f = fakeFetch({ [seg(BCDN, 12)]: 'nobody' });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    expect(await route(seg(BCDN, 12))).toBe(seg(BCDN, 12));
  });

  it('counts empty chunks as zero bytes and survives a reader that fails to cancel', async () => {
    const f = fakeFetch({ [seg(BCDN, 13)]: 'emptychunk', [seg(BCDN, 14)]: 'badcancel' }, { size: 4 * 1024 });
    const route = createSegmentRouter({ ...fast, fetchImpl: f });
    expect(await route(seg(BCDN, 13))).toBe(seg(BCDN, 13));
    expect(await route(seg(BCDN, 14))).toBe(seg(BCDN, 14));
  });

  it('tries each fallback in turn and takes the first that passes', async () => {
    const f = fakeFetch({ [seg(BCDN, 15)]: 'fail', [seg(HOT, 15)]: 'fail' });
    const route = createSegmentRouter({ ...fast, fetchImpl: f, fallbacks: [HOT, AUDIO] });
    expect(await route(seg(BCDN, 15))).toBe(seg(AUDIO, 15));
    expect(f.calls.map((c) => c.url)).toEqual([seg(BCDN, 15), seg(HOT, 15), seg(AUDIO, 15)]);
  });

  it('bounds the cache, dropping the oldest entry first', async () => {
    const f = fakeFetch();
    const route = createSegmentRouter({ ...fast, fetchImpl: f, maxEntries: 2 });
    for (const n of [20, 21, 22]) await route(seg(BCDN, n));
    await route(seg(BCDN, 22));
    expect(f.calls).toHaveLength(3); // 22 still cached
    await route(seg(BCDN, 20));
    expect(f.calls).toHaveLength(4); // 20 was dropped
  });

  it('uses the global fetch by default', async () => {
    const f = fakeFetch();
    vi.stubGlobal('fetch', f);
    const route = createSegmentRouter();
    expect(await route(seg(BCDN, 30))).toBe(seg(BCDN, 30));
    expect(f.calls[0].range).toBe(`bytes=-${256 * 1024}`);
  });
});

describe('probe settings from the environment', () => {
  afterEach(() => { vi.useRealTimers(); });

  async function rangeAndTimes(env) {
    const mod = requireFresh('hlsGateways.js', env);
    vi.useFakeTimers();
    const f = fakeFetch({ [seg(BCDN, 1)]: 'hang', [seg(AUDIO, 1)]: 'hang' });
    const route = mod.createSegmentRouter({ fetchImpl: f });
    const t = track(route(seg(BCDN, 1)));
    let waited = 0;
    while (!t.done && waited < 20000) {
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      waited += 100;
    }
    return { range: f.calls[0].range, waited, calls: f.calls.length };
  }

  it('defaults: 256 KB probe, 700ms hedge, 3s fallback limit', async () => {
    const r = await rangeAndTimes({});
    expect(r.range).toBe('bytes=-262144');
    expect(r.waited).toBe(3700);
  });

  it('reads SEGMENT_* values, rounding down', async () => {
    const r = await rangeAndTimes({
      SEGMENT_PROBE_BYTES: '4096.9',
      SEGMENT_PROBE_TIMEOUT_MS: '500',
      SEGMENT_HEDGE_MS: '100',
      SEGMENT_FALLBACK_PROBE_TIMEOUT_MS: '300',
    });
    expect(r.range).toBe('bytes=-4096');
    expect(r.waited).toBe(500); // fallback asked at 100ms, gave up at 400ms, Bunny at 500ms
    expect(r.calls).toBe(2);
  });

  it('ignores values below the minimum or not numbers', async () => {
    const r = await rangeAndTimes({
      SEGMENT_PROBE_BYTES: '10',
      SEGMENT_PROBE_TIMEOUT_MS: 'abc',
      SEGMENT_HEDGE_MS: '-5',
      SEGMENT_FALLBACK_PROBE_TIMEOUT_MS: '199',
    });
    expect(r.range).toBe('bytes=-262144');
    expect(r.waited).toBe(3700);
  });
});
