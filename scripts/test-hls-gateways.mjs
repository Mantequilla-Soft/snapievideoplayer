/**
 * 🛰️ Segment gateway choice for /hls (../hlsGateways.js).
 *
 * A media playlist's segments must point at a gateway that can serve them: Bunny
 * hangs on segments of an unannounced CID while ipfs-audio.3speak.tv has them.
 * Fetch is faked per URL: 'ok', 'fail' (an error status) or 'hang' (never answers
 * until the probe's own timeout aborts it).
 *
 * Usage: node scripts/test-hls-gateways.mjs
 */
import hg from '../hlsGateways.js';

const { createSegmentGatewayPicker, isMediaPlaylist, lastSegmentRef, gatewayOf, cidOf } = hg;

let fails = 0;
const is = (l, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  if (!ok) fails++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${l.padEnd(60)} ${JSON.stringify(g)}${ok ? '' : `  want ${JSON.stringify(w)}`}`);
};

const CID = 'QmSK7j5YJfzdKRcziM8wCzKeL4gggW4QJL9fy4GkWc7yKB';
const BCDN = 'https://ipfs-3speak.b-cdn.net';
const AUDIO = 'https://ipfs-audio.3speak.tv';
const PLAYLIST = `${BCDN}/ipfs/${CID}/480p/index.m3u8`;
const MEDIA = [
  '#EXTM3U', '#EXT-X-TARGETDURATION:12', '#EXTINF:12.2,', '480p_0.ts',
  '#EXTINF:6.7,', '480p_1.ts', '#EXTINF:5.4,', '480p_2.ts', '#EXT-X-ENDLIST', '',
].join('\n');
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000\n480p/index.m3u8\n';

function fakeFetch(answers) {
  const calls = [];
  const fn = (url, opts) => {
    calls.push({ url, range: opts?.headers?.Range });
    const a = answers[url] || 'ok';
    if (a === 'hang') {
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return Promise.resolve({ ok: a === 'ok', status: a === 'ok' ? 206 : 502, body: { cancel: async () => {} } });
  };
  fn.calls = calls;
  return fn;
}
const fast = { probeMs: 30, fallbackProbeMs: 30 };

console.log('── helpers ──');
is('media playlist recognised', isMediaPlaylist(MEDIA), true);
is('master is not a media playlist', isMediaPlaylist(MASTER), false);
is('last segment reference', lastSegmentRef(MEDIA), '480p_2.ts');
is('gateway of an /ipfs/ url', gatewayOf(PLAYLIST), BCDN);
is('cid of an /ipfs/ url', cidOf(PLAYLIST), CID);
is('no gateway for the /hls proxy', gatewayOf('https://play.3speak.tv/hls?u=x'), null);

console.log('── choosing ──');
{
  const f = fakeFetch({});
  const pick = createSegmentGatewayPicker({ ...fast, fetchImpl: f });
  is('healthy Bunny keeps Bunny', await pick(PLAYLIST, MEDIA), BCDN);
  is('…after probing the LAST segment, one byte', f.calls, [{ url: `${BCDN}/ipfs/${CID}/480p/480p_2.ts`, range: 'bytes=0-0' }]);
  await pick(`${BCDN}/ipfs/${CID}/720p/index.m3u8`, MEDIA);
  is('another rendition of that CID is not probed again', f.calls.length, 1);
}
{
  const f = fakeFetch({ [`${BCDN}/ipfs/${CID}/480p/480p_2.ts`]: 'hang' });
  const pick = createSegmentGatewayPicker({ ...fast, fetchImpl: f });
  is('Bunny silent, ipfs-audio answers → ipfs-audio', await pick(PLAYLIST, MEDIA), AUDIO);
  is('…probed ipfs-audio at the same path', f.calls[1].url, `${AUDIO}/ipfs/${CID}/480p/480p_2.ts`);
  is('the choice holds for the CID', await pick(`${BCDN}/ipfs/${CID}/720p/index.m3u8`, MEDIA), AUDIO);
  is('…without probing again', f.calls.length, 2);
}
{
  const f = fakeFetch({ [`${BCDN}/ipfs/${CID}/480p/480p_2.ts`]: 'fail' });
  const pick = createSegmentGatewayPicker({ ...fast, fetchImpl: f });
  is('a Bunny error status moves to ipfs-audio too', await pick(PLAYLIST, MEDIA), AUDIO);
}
{
  let t = 0;
  const f = fakeFetch({
    [`${BCDN}/ipfs/${CID}/480p/480p_2.ts`]: 'hang',
    [`${AUDIO}/ipfs/${CID}/480p/480p_2.ts`]: 'fail',
  });
  const pick = createSegmentGatewayPicker({ ...fast, fetchImpl: f, now: () => t, missCacheMs: 1000, cacheMs: 60000 });
  is('nobody answers → keep Bunny', await pick(PLAYLIST, MEDIA), BCDN);
  await pick(PLAYLIST, MEDIA);
  is('…remembered briefly', f.calls.length, 2);
  t = 2000;
  await pick(PLAYLIST, MEDIA);
  is('…then looked at again', f.calls.length, 4);
}
{
  const f = fakeFetch({});
  const pick = createSegmentGatewayPicker({ ...fast, fetchImpl: f });
  is('a master is left alone', await pick(`${BCDN}/ipfs/${CID}/manifest.m3u8`, MASTER), BCDN);
  is('a playlist on ipfs-audio itself is not re-probed elsewhere', await pick(`${AUDIO}/ipfs/${CID}/480p/index.m3u8`,
    MEDIA.replace('480p_2.ts', 'x.ts')), AUDIO);
  const other = MEDIA.replace('480p_2.ts', 'https://elsewhere.example/seg.ts');
  is('segments on another host are left alone', await pick(PLAYLIST, other), BCDN);
  is('…and no request was made for them', f.calls.filter((c) => c.url.includes('elsewhere')).length, 0);
}
{
  const f = fakeFetch({});
  const pick = createSegmentGatewayPicker({ ...fast, fetchImpl: f, maxEntries: 2 });
  for (const c of ['QmA', 'QmB', 'QmC']) await pick(`${BCDN}/ipfs/${c}/480p/index.m3u8`, MEDIA);
  await pick(`${BCDN}/ipfs/QmA/480p/index.m3u8`, MEDIA);
  is('the cache is bounded (oldest dropped, probed again)', f.calls.length, 4);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
