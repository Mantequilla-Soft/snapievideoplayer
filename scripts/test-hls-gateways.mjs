/**
 * 🛰️ Per-segment gateway choice for /hls + /seg (../hlsGateways.js).
 *
 * Bunny's cache is mixed segment by segment: cached ones load at once, the rest of
 * an unannounced CID hang or trickle, while ipfs-audio.3speak.tv has them all.
 * Fetch is faked per URL: 'ok', 'slow' (passes, but after the hedge delay),
 * 'trickle' (first chunk, then nothing), 'hang' (never answers) or 'fail' (502).
 *
 * Usage: node scripts/test-hls-gateways.mjs
 */
import hg from '../hlsGateways.js';

const { createSegmentRouter, isSegmentUrl, isPlaylistUrl, segmentRouteUrl, gatewayOf } = hg;

let fails = 0;
const is = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) fails++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${l.padEnd(62)} ${JSON.stringify(g)}${ok ? '' : `  want ${JSON.stringify(w)}`}`);
};

const CID = 'QmSK7j5YJfzdKRcziM8wCzKeL4gggW4QJL9fy4GkWc7yKB';
const BCDN = 'https://ipfs-3speak.b-cdn.net';
const AUDIO = 'https://ipfs-audio.3speak.tv';
const seg = (host, n) => `${host}/ipfs/${CID}/480p/480p_${n}.ts`;

const waitAbort = (signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));

function body(mode, signal, size) {
  let sent = 0;
  return {
    getReader: () => ({
      read: () => {
        if (sent >= size) return Promise.resolve({ done: true });
        if (mode === 'trickle' && sent > 0) return waitAbort(signal);
        sent += 1024;
        return Promise.resolve({ done: false, value: new Uint8Array(1024) });
      },
      cancel: async () => {},
    }),
  };
}

function fakeFetch(answers, { size = 64 * 1024, slowMs = 60 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, range: opts?.headers?.Range });
    const a = answers[url] || 'ok';
    if (a === 'hang') return waitAbort(opts.signal);
    if (a === 'slow') await new Promise((r) => setTimeout(r, slowMs));
    const ok = a !== 'fail';
    return { ok, status: ok ? 206 : 502, body: body(a, opts.signal, size) };
  };
  fn.calls = calls;
  return fn;
}
const fast = { probeMs: 120, hedgeMs: 30, fallbackProbeMs: 120, probeBytes: 8 * 1024 };

console.log('── which urls ──');
is('a Bunny segment', isSegmentUrl(seg(BCDN, 0)), true);
is('an ipfs-audio segment', isSegmentUrl(seg(AUDIO, 0)), true);
is('not a playlist', isSegmentUrl(`${BCDN}/ipfs/${CID}/480p/index.m3u8`), false);
is('not the non-CORS gateway', isSegmentUrl(seg('https://ipfs.3speak.tv', 0)), false);
is('not another host', isSegmentUrl(`https://example.com/ipfs/${CID}/a.ts`), false);
is('not plain http', isSegmentUrl(seg('http://ipfs-3speak.b-cdn.net', 0)), false);
is('not a bare CID', isSegmentUrl(`${BCDN}/ipfs/${CID}`), false);
is('playlist detection', [isPlaylistUrl('a/index.m3u8'), isPlaylistUrl('a/b.ts')], [true, false]);
is('gateway of a url', gatewayOf(seg(BCDN, 1)), BCDN);
is('/seg address keeps the file name, url encoded',
  segmentRouteUrl('https://play.3speak.tv', seg(BCDN, 2)),
  `https://play.3speak.tv/seg/480p_2.ts?u=${encodeURIComponent(seg(BCDN, 2))}`);
is('odd characters in the name are made safe',
  segmentRouteUrl('https://p', `${BCDN}/ipfs/${CID}/a b"c.ts`).split('?')[0], 'https://p/seg/a_b_c.ts');

console.log('── routing one segment ──');
{
  const f = fakeFetch({});
  const route = createSegmentRouter({ ...fast, fetchImpl: f });
  is('cached on Bunny → Bunny', await route(seg(BCDN, 0)), seg(BCDN, 0));
  is('…after reading the END of it', f.calls[0], { url: seg(BCDN, 0), range: 'bytes=-8192' });
  await route(seg(BCDN, 0));
  is('…and the answer is kept', f.calls.length, 1);
}
{
  // 2026-11-09, after #58: Bunny had 480p_0 cached and hung on 480p_1.
  const f = fakeFetch({ [seg(BCDN, 1)]: 'hang' });
  const route = createSegmentRouter({ ...fast, fetchImpl: f });
  is('segment 0 cached → Bunny', await route(seg(BCDN, 0)), seg(BCDN, 0));
  is('segment 1 hanging → ipfs-audio', await route(seg(BCDN, 1)), seg(AUDIO, 1));
}
{
  const f = fakeFetch({ [seg(BCDN, 2)]: 'trickle' });
  const route = createSegmentRouter({ ...fast, fetchImpl: f });
  is('Bunny trickling after the first bytes → ipfs-audio', await route(seg(BCDN, 2)), seg(AUDIO, 2));
}
{
  const f = fakeFetch({ [seg(BCDN, 2)]: 'fail' });
  const route = createSegmentRouter({ ...fast, fetchImpl: f });
  is('Bunny error → ipfs-audio', await route(seg(BCDN, 2)), seg(AUDIO, 2));
}
{
  const f = fakeFetch({ [seg(BCDN, 3)]: 'slow' });
  const route = createSegmentRouter({ ...fast, fetchImpl: f });
  is('Bunny slow but within its limit → still Bunny', await route(seg(BCDN, 3)), seg(BCDN, 3));
  is('…ipfs-audio was asked meanwhile (hedge)', f.calls.map((c) => c.url), [seg(BCDN, 3), seg(AUDIO, 3)]);
}
{
  const f = fakeFetch({});
  const route = createSegmentRouter({ ...fast, fetchImpl: f });
  await route(seg(BCDN, 4));
  is('Bunny fast → ipfs-audio never asked', f.calls.length, 1);
}
{
  let t = 0;
  const f = fakeFetch({ [seg(BCDN, 5)]: 'hang', [seg(AUDIO, 5)]: 'fail' });
  const route = createSegmentRouter({ ...fast, fetchImpl: f, now: () => t, missCacheMs: 1000, cacheMs: 60000 });
  is('nobody answers → the original', await route(seg(BCDN, 5)), seg(BCDN, 5));
  await route(seg(BCDN, 5));
  is('…remembered briefly', f.calls.length, 2);
  t = 2000;
  await route(seg(BCDN, 5));
  is('…then looked at again', f.calls.length, 4);
}
{
  const f = fakeFetch({ [seg(BCDN, 6)]: 'slow' }, { slowMs: 50 });
  const route = createSegmentRouter({ ...fast, hedgeMs: 1000, fetchImpl: f });
  const both = await Promise.all([route(seg(BCDN, 6)), route(seg(BCDN, 6)), route(seg(BCDN, 6))]);
  is('concurrent requests share one decision', [both, f.calls.length], [[seg(BCDN, 6), seg(BCDN, 6), seg(BCDN, 6)], 1]);
}
{
  const f = fakeFetch({});
  const route = createSegmentRouter({ ...fast, fetchImpl: f });
  is('already on ipfs-audio → unchanged, nothing asked', [await route(seg(AUDIO, 7)), f.calls.length], [seg(AUDIO, 7), 0]);
}
{
  const f = fakeFetch({}, { size: 2 * 1024 });
  const route = createSegmentRouter({ ...fast, fetchImpl: f });
  is('a segment smaller than the probe passes once all in', await route(seg(BCDN, 8)), seg(BCDN, 8));
}
{
  const f = fakeFetch({ [seg(BCDN, 9)]: 'hang', [seg(AUDIO, 9)]: 'hang' });
  const route = createSegmentRouter({ fetchImpl: f, probeMs: 150, hedgeMs: 50, fallbackProbeMs: 150, probeBytes: 8 * 1024 });
  const t0 = Date.now();
  await route(seg(BCDN, 9));
  const took = Date.now() - t0;
  is('both silent: waits ~hedge + fallback limit, not the sum (<260ms)', took < 260, true);
}
{
  const f = fakeFetch({});
  const route = createSegmentRouter({ ...fast, fetchImpl: f, maxEntries: 2 });
  for (const n of [10, 11, 12]) await route(seg(BCDN, n));
  await route(seg(BCDN, 10));
  is('the cache is bounded (oldest dropped, asked again)', f.calls.length, 4);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
