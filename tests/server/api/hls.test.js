// The HLS gateway layer: GET /hls (manifest race + rewrite), GET /seg/:name
// (per segment gateway redirect) and GET /ipfs-proxy (byte proxy for the non-CORS
// gateway).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { closeTestDb } from '../../helpers/mongo.js';
import { loadServer, stopServer } from './_helpers/loadServer.js';
import { installFetch, calledUrls, text, hang, delay } from './_helpers/fakeFetch.js';
import { CID, SELF } from './_helpers/fixtures.js';

const HOT = 'https://hotipfs-3speak-1.b-cdn.net';
const BCDN = 'https://ipfs-3speak.b-cdn.net';
const SUPER = 'https://ipfs.3speak.tv';
const AUDIO = 'https://ipfs-audio.3speak.tv';
const at = (gw, file) => `${gw}/ipfs/${CID}/${file}`;
const enc = encodeURIComponent;

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480,CODECS="mp4a.40.2"',
  '480p/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1400000,CODECS="avc1.64001f,mp4a.40.2"',
  '720p/index.m3u8',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="en",URI="subs/en.m3u8"',
  '',
].join('\r\n');

const VARIANT = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:6',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k1"',
  '#EXTINF:6.0,',
  '480p_0.ts',
  '',
  '#EXTINF:6.0,',
  at(BCDN, '480p/480p_1.ts'),
  '#EXTINF:6.0,',
  'https://other-gw.test/ipfs/QmElsewhere/seg.ts',
  '#EXT-X-ENDLIST',
].join('\n');

let app;

beforeAll(async () => { app = await loadServer(); });
afterAll(async () => { await stopServer(); await closeTestDb(); });

/** fetch answering per URL: a string is a 200 body, a number a bare status, a function is called. */
function gateways(map) {
  return installFetch((url, init) => {
    const a = map[url];
    if (a === undefined) return text('gone', 404);
    if (typeof a === 'function') return a(init);
    if (typeof a === 'number') return text('', a);
    return text(a);
  });
}

describe('GET /hls: input guard', () => {
  it.each([
    ['no u', ''],
    ['plain http', `?u=${enc(`http://ipfs-3speak.b-cdn.net/ipfs/${CID}/manifest.m3u8`)}`],
    ['no /ipfs/ path', `?u=${enc('https://hotipfs-3speak-1.b-cdn.net/files/manifest.m3u8')}`],
    ['not a playlist', `?u=${enc(at(HOT, 'video.mp4'))}`],
  ])('400 for %s, without fetching anything', async (_label, qs) => {
    const f = installFetch();
    const res = await request(app).get(`/hls${qs}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe('bad manifest url');
    expect(f).not.toHaveBeenCalled();
  });

  it('never contacts a host outside the gateway list, but serves the same object from ours', async () => {
    const f = gateways({ [at(HOT, 'manifest.m3u8')]: MASTER });
    const res = await request(app).get(`/hls?u=${enc(`https://attacker.example/ipfs/${CID}/manifest.m3u8`)}`);
    expect(calledUrls(f).some((u) => !u.startsWith(`${HOT}/`) && !u.startsWith(`${BCDN}/`)
      && !u.startsWith(`${SUPER}/`) && !u.startsWith(`${AUDIO}/`))).toBe(false);
    expect(calledUrls(f)[0]).toBe(at(HOT, 'manifest.m3u8'));
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^#EXTM3U/);
  });

  it('tries a configured IPFS_GATEWAY host first', async () => {
    const f = gateways({ [`https://gw.test/ipfs/${CID}/manifest.m3u8`]: MASTER });
    const res = await request(app).get(`/hls?u=${enc(`https://gw.test/ipfs/${CID}/manifest.m3u8`)}`);
    expect(res.status).toBe(200);
    expect(calledUrls(f)[0]).toBe(`https://gw.test/ipfs/${CID}/manifest.m3u8`);
  });

  it.each([
    ['..', '../api/v0/manifest.m3u8'],
    ['encoded ..', '%2e%2e/api/v0/manifest.m3u8'],
    ['deep ..', `${CID}/../../api/v0/manifest.m3u8`],
  ])('400 for a path that climbs out of /ipfs/ (%s), without fetching anything', async (_label, path) => {
    const f = installFetch();
    const res = await request(app).get(`/hls?u=${enc(`${HOT}/ipfs/${path}`)}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe('bad manifest url');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('GET /hls: master manifest from the hot zone', () => {
  it('serves the rewritten manifest with HLS headers', async () => {
    const f = gateways({ [at(HOT, 'manifest.m3u8')]: MASTER });
    const res = await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    // Names the gateway that served it, readable cross-origin (src/sourceReport.js).
    expect(res.headers['x-snapie-source']).toBe(at(HOT, 'manifest.m3u8'));
    expect(res.headers['access-control-expose-headers']).toBe('X-Snapie-Source');
    expect(res.text.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      // An audio-only CODECS on a video stream is dropped...
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480',
      `${SELF}/hls?u=${enc(at(HOT, '480p/index.m3u8'))}`,
      // ...a real video codec is kept.
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,CODECS="avc1.64001f,mp4a.40.2"',
      `${SELF}/hls?u=${enc(at(HOT, '720p/index.m3u8'))}`,
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="en",URI="${SELF}/hls?u=${enc(at(HOT, 'subs/en.m3u8'))}"`,
      '',
    ]);
    // The hot zone answered, so nothing else was asked.
    expect(calledUrls(f)).toEqual([at(HOT, 'manifest.m3u8')]);
    expect(f.mock.calls[0][1]).toMatchObject({ redirect: 'follow' });
  });

  it('answers on /hls/manifest.m3u8 too (for players that need the extension)', async () => {
    gateways({ [at(HOT, 'manifest.m3u8')]: MASTER });
    const res = await request(app).get(`/hls/manifest.m3u8?u=${enc(at(HOT, 'manifest.m3u8'))}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('#EXTM3U');
  });

  it('keeps a STREAM-INF line without CODECS as it is', async () => {
    gateways({ [at(HOT, 'nocodecs.m3u8')]: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n480p/index.m3u8' });
    const res = await request(app).get(`/hls?u=${enc(at(HOT, 'nocodecs.m3u8'))}`);
    expect(res.text.split('\n')[1]).toBe('#EXT-X-STREAM-INF:BANDWIDTH=1');
  });
});

describe('GET /hls: variant playlists', () => {
  it('sends segments, init maps and keys on our gateways through /seg', async () => {
    gateways({ [at(HOT, '480p/index.m3u8')]: VARIANT });
    const res = await request(app).get(`/hls?u=${enc(at(HOT, '480p/index.m3u8'))}`);
    expect(res.status).toBe(200);
    expect(res.text.split('\n')).toEqual([
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      `#EXT-X-MAP:URI="${SELF}/seg/init.mp4?u=${enc(at(HOT, '480p/init.mp4'))}"`,
      // Not an IPFS URL: left alone.
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k1"',
      '#EXTINF:6.0,',
      `${SELF}/seg/480p_0.ts?u=${enc(at(HOT, '480p/480p_0.ts'))}`,
      '',
      '#EXTINF:6.0,',
      // Already absolute on another CDN: still routed per segment.
      `${SELF}/seg/480p_1.ts?u=${enc(at(BCDN, '480p/480p_1.ts'))}`,
      '#EXTINF:6.0,',
      // An IPFS URL on a gateway /seg does not know: handed out as is.
      'https://other-gw.test/ipfs/QmElsewhere/seg.ts',
      '#EXT-X-ENDLIST',
    ]);
  });
});

describe('GET /hls: gateway race', () => {
  it('races the other CORS gateways when the hot zone is gone, never the non-CORS one', async () => {
    const f = gateways({
      [at(HOT, 'manifest.m3u8')]: 404,
      [at(BCDN, 'manifest.m3u8')]: async () => { await delay(150); return text(MASTER); },
      [at(AUDIO, 'manifest.m3u8')]: MASTER,
      [at(SUPER, 'manifest.m3u8')]: MASTER,
    });
    const res = await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}`);
    expect(res.status).toBe(200);
    // The fastest CORS gateway becomes the base for the children.
    expect(res.text).toContain(`${SELF}/hls?u=${enc(at(AUDIO, '480p/index.m3u8'))}`);
    expect(res.headers['x-snapie-source']).toBe(at(AUDIO, 'manifest.m3u8'));
    const urls = calledUrls(f);
    expect(urls[0]).toBe(at(HOT, 'manifest.m3u8'));
    expect(urls.slice(1).sort()).toEqual([at(BCDN, 'manifest.m3u8'), at(AUDIO, 'manifest.m3u8')].sort());
  });

  it('a 200 that is not a playlist counts as a miss', async () => {
    gateways({
      [at(HOT, 'manifest.m3u8')]: '<html>gateway error</html>',
      [at(BCDN, 'manifest.m3u8')]: MASTER,
    });
    const res = await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(enc(at(BCDN, '480p/index.m3u8')));
  });

  it('gives up on a hanging gateway after HLS_FETCH_TIMEOUT_MS', async () => {
    gateways({
      [at(HOT, 'manifest.m3u8')]: (init) => hang(init),
      [at(BCDN, 'manifest.m3u8')]: MASTER,
    });
    const t0 = Date.now();
    const res = await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}`);
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(res.text).toContain(enc(at(BCDN, '480p/index.m3u8')));
  });

  it('an upstream on the non-CORS gateway is first tried on the CORS ones', async () => {
    const f = gateways({ [at(HOT, 'manifest.m3u8')]: MASTER, [at(SUPER, 'manifest.m3u8')]: MASTER });
    const res = await request(app).get(`/hls?u=${enc(at(SUPER, 'manifest.m3u8'))}`);
    expect(res.status).toBe(200);
    expect(calledUrls(f)).not.toContain(at(SUPER, 'manifest.m3u8'));
  });

  it('falls back to the non-CORS gateway as a last resort and proxies its children', async () => {
    const f = gateways({ [at(SUPER, 'manifest.m3u8')]: MASTER });
    const res = await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`${SELF}/hls?u=${enc(at(SUPER, '480p/index.m3u8'))}`);
    expect(calledUrls(f).at(-1)).toBe(at(SUPER, 'manifest.m3u8'));
  });

  it('a variant from the non-CORS gateway sends its bytes through /ipfs-proxy', async () => {
    gateways({ [at(SUPER, '480p/index.m3u8')]: VARIANT });
    const res = await request(app).get(`/hls?u=${enc(at(HOT, '480p/index.m3u8'))}`);
    const lines = res.text.split('\n');
    expect(lines).toContain(`#EXT-X-MAP:URI="${SELF}/ipfs-proxy?u=${enc(at(SUPER, '480p/init.mp4'))}"`);
    expect(lines).toContain(`${SELF}/ipfs-proxy?u=${enc(at(SUPER, '480p/480p_0.ts'))}`);
    expect(lines).toContain(`${SELF}/ipfs-proxy?u=${enc(at(BCDN, '480p/480p_1.ts'))}`);
  });

  it('504 fast when every gateway fails', async () => {
    const f = gateways({ [at(BCDN, 'manifest.m3u8')]: 502, [at(AUDIO, 'manifest.m3u8')]: () => { throw new Error('ECONNREFUSED'); } });
    const res = await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}`);
    expect(res.status).toBe(504);
    expect(res.text).toBe('manifest unreachable on all gateways');
    expect(new Set(calledUrls(f))).toEqual(new Set(['manifest.m3u8'].flatMap((x) => [HOT, BCDN, SUPER, AUDIO].map((g) => at(g, x)))));
  });
});

describe('GET /seg/:name', () => {
  const PROBE = 256 * 1024;
  const big = () => new Response(new Uint8Array(PROBE + 10), { status: 206 });

  it.each([
    ['no u', ''],
    ['a playlist', `?u=${enc(at(BCDN, '480p/index.m3u8'))}`],
    ['the non-CORS gateway', `?u=${enc(at(SUPER, '480p/a.ts'))}`],
    ['another host', `?u=${enc(`https://example.com/ipfs/${CID}/a.ts`)}`],
  ])('400 for %s', async (_label, qs) => {
    installFetch();
    const res = await request(app).get(`/seg/a.ts${qs}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe('bad segment url');
  });

  it('redirects to Bunny when it delivers the end of the segment', async () => {
    const seg = at(BCDN, '480p/seg-ok-0.ts');
    const f = installFetch((url) => (url === seg ? big() : undefined));
    const res = await request(app).get(`/seg/seg-ok-0.ts?u=${enc(seg)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(seg);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(f.mock.calls[0][1].headers).toEqual({ Range: `bytes=-${PROBE}` });
  });

  it('remembers the decision for that segment', async () => {
    const seg = at(BCDN, '480p/seg-cache-0.ts');
    const f = installFetch((url) => (url === seg ? big() : undefined));
    await request(app).get(`/seg/x.ts?u=${enc(seg)}`);
    const again = await request(app).get(`/seg/x.ts?u=${enc(seg)}`);
    expect(again.headers.location).toBe(seg);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('redirects to ipfs-audio when Bunny fails the probe', async () => {
    const seg = at(HOT, '480p/seg-fb-0.ts');
    const alt = at(AUDIO, '480p/seg-fb-0.ts');
    const f = installFetch((url) => (url === seg ? text('', 502) : url === alt ? big() : undefined));
    const res = await request(app).get(`/seg/seg-fb-0.ts?u=${enc(seg)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(alt);
    expect(calledUrls(f)).toEqual([seg, alt]);
  });

  it('falls back to the original when nobody delivers', async () => {
    const seg = at(BCDN, '480p/seg-none-0.ts');
    installFetch(() => text('', 503));
    const res = await request(app).get(`/seg/seg-none-0.ts?u=${enc(seg)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(seg);
  });

  it('a segment already on ipfs-audio is redirected without probing', async () => {
    const seg = at(AUDIO, '480p/seg-audio-0.ts');
    const f = installFetch();
    const res = await request(app).get(`/seg/seg-audio-0.ts?u=${enc(seg)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(seg);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('GET /ipfs-proxy', () => {
  it.each([
    ['no u', ''],
    ['plain http', `?u=${enc(`http://ipfs.3speak.tv/ipfs/${CID}/a.ts`)}`],
    ['no /ipfs/ path', `?u=${enc('https://ipfs.3speak.tv/api/v0/cat')}`],
  ])('400 for %s', async (_label, qs) => {
    const f = installFetch();
    const res = await request(app).get(`/ipfs-proxy${qs}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe('bad ipfs url');
    expect(f).not.toHaveBeenCalled();
  });

  it('never proxies bytes from a host outside the gateway list', async () => {
    const f = installFetch((url) => (url.startsWith('https://attacker.example/') ? text('secret') : text('gone', 404)));
    const res = await request(app).get(`/ipfs-proxy?u=${enc('https://attacker.example/ipfs/x/a.ts')}`);
    expect(calledUrls(f).some((u) => u.startsWith('https://attacker.example/'))).toBe(false);
    expect(res.status).toBe(502);
    expect(res.text).not.toContain('secret');
  });

  it('strict: only the gateway in u=, a 502 rather than another gateway', async () => {
    const f = installFetch((url) => (url === at(SUPER, '480p/a.ts') ? text('gone', 404) : text('bytes')));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, '480p/a.ts'))}&strict=1`);
    expect(res.status).toBe(502);
    expect(calledUrls(f)).toEqual([at(SUPER, '480p/a.ts')]);
    const elsewhere = await request(app).get(`/ipfs-proxy?u=${enc(`https://elsewhere.example/ipfs/${CID}/480p/a.ts`)}&strict=1`);
    expect(elsewhere.status).toBe(400);
  });

  it('serves an object named on an unknown host from our gateways instead', async () => {
    const f = installFetch((url) => (url === at(SUPER, '480p/a.ts') ? text('bytes') : text('gone', 404)));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(`https://elsewhere.example/ipfs/${CID}/480p/a.ts`)}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp2t');
    expect(calledUrls(f).every((u) => !u.startsWith('https://elsewhere.example/'))).toBe(true);
  });

  it.each([
    ['..', '../api/v0/cat'],
    ['encoded ..', '%2E%2E/api/v0/cat'],
  ])('400 for a path that climbs out of /ipfs/ (%s), without fetching anything', async (_label, path) => {
    const f = installFetch();
    const res = await request(app).get(`/ipfs-proxy?u=${enc(`${SUPER}/ipfs/${path}`)}`);
    expect(res.status).toBe(400);
    expect(res.text).toBe('bad ipfs url');
    expect(f).not.toHaveBeenCalled();
  });

  it('streams the object with a corrected type and immutable caching', async () => {
    const bytes = Buffer.from('segment-bytes-0123456789');
    installFetch((url) => (url === at(SUPER, '480p/a.ts')
      ? new Response(bytes, { headers: { 'content-type': 'text/vnd.trolltech.linguist', 'content-length': String(bytes.length), etag: '"abc"', 'x-private': 'no' } })
      : undefined));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, '480p/a.ts'))}`).buffer(true).parse((r, cb) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp2t');
    expect(res.headers['content-length']).toBe(String(bytes.length));
    expect(res.headers.etag).toBe('"abc"');
    expect(res.headers['x-private']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(Buffer.compare(res.body, bytes)).toBe(0);
  });

  it.each([
    ['init.m4s', 'video/iso.segment'], ['v.mp4', 'video/mp4'], ['subs.vtt', 'text/vtt'], ['k.key', 'application/octet-stream'],
  ])('types %s as %s', async (file, type) => {
    installFetch(() => text('x', 200, { 'content-type': 'application/x-whatever' }));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, file))}`);
    expect(res.headers['content-type']).toMatch(new RegExp(`^${type.replace('/', '\\/')}`));
  });

  it('keeps the upstream type for an extension it does not know', async () => {
    installFetch(() => text('x', 200, { 'content-type': 'image/jpeg' }));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, 'thumb.jpg'))}`);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });

  it('forwards Range and answers 206 with the upstream range headers', async () => {
    const f = installFetch(() => new Response('0123', {
      status: 206, headers: { 'content-range': 'bytes 0-3/100', 'accept-ranges': 'bytes' },
    }));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, '480p/b.ts'))}`).set('Range', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-3/100');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(f.mock.calls[0][1].headers).toEqual({ Range: 'bytes=0-3' });
  });

  it('sends no Range header upstream when the player sent none', async () => {
    const f = installFetch(() => text('x'));
    await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, '480p/c.ts'))}`);
    expect(f.mock.calls[0][1].headers).toBeUndefined();
  });

  it('tries the same object on the next gateway when one fails', async () => {
    const f = installFetch((url) => {
      if (url === at(SUPER, '480p/d.bin')) return text('', 500);
      if (url === at(HOT, '480p/d.bin')) throw new Error('ECONNRESET');
      if (url === at(BCDN, '480p/d.bin')) return text('from-bcdn');
      return undefined;
    });
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, '480p/d.bin'))}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('from-bcdn');
    expect(calledUrls(f)).toEqual([at(SUPER, '480p/d.bin'), at(HOT, '480p/d.bin'), at(BCDN, '480p/d.bin')]);
  });

  it('502 naming the last status when no gateway serves it', async () => {
    installFetch(() => text('', 410));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, '480p/e.ts'))}`);
    expect(res.status).toBe(502);
    expect(res.text).toBe('ipfs-proxy: no gateway served this object (410)');
  });

  it('502 "unreachable" when every gateway errors', async () => {
    installFetch(() => { throw new Error('ENOTFOUND'); });
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, '480p/f.ts'))}`);
    expect(res.status).toBe(502);
    expect(res.text).toBe('ipfs-proxy: no gateway served this object (unreachable)');
  });

  it('an empty upstream body ends the response cleanly', async () => {
    installFetch(() => new Response(null, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, 'empty'))}`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
  });

  it('502 when the upstream body errors before any byte', async () => {
    installFetch(() => new Response(new ReadableStream({ start(c) { c.error(new Error('stall')); } })));
    const res = await request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, 'broken.bin'))}`);
    expect(res.status).toBe(502);
  });

  it('cuts the connection when the upstream body errors mid-stream', async () => {
    installFetch(() => new Response(new ReadableStream({
      async pull(c) {
        c.enqueue(new Uint8Array(64 * 1024));
        await delay(20);
        c.error(new Error('stall'));
      },
    })));
    await expect(request(app).get(`/ipfs-proxy?u=${enc(at(SUPER, 'cut.bin'))}`)).rejects.toThrow();
  });
});

describe('S3 archive (storage_state, issue #54)', () => {
  const ZONE = 'https://buttercloud.b-cdn.net/videos-test';
  const DIRECT = 'https://s3.3speak.tv/videos-test';
  const s3 = (base, file) => `${base}/${CID}/${file}`;
  const PROBE = 256 * 1024;
  const big = () => new Response(new Uint8Array(PROBE + 10), { status: 206 });
  const S3_VARIANT = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXTINF:6.0,', '480p_0.ts', '#EXT-X-ENDLIST'].join('\n');

  describe('GET /hls', () => {
    it('archived: serves the S3 zone manifest with the codec fix, children flagged', async () => {
      const f = gateways({ [s3(ZONE, 'manifest.m3u8')]: MASTER });
      const res = await request(app).get(`/hls?u=${enc(s3(ZONE, 'manifest.m3u8'))}&s3=1`);
      expect(res.status).toBe(200);
      const lines = res.text.split('\n');
      expect(lines[2]).toBe('#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480');
      expect(lines[3]).toBe(`${SELF}/hls?u=${enc(s3(ZONE, '480p/index.m3u8'))}&s3=1`);
      expect(lines[6]).toContain(`URI="${SELF}/hls?u=${enc(s3(ZONE, 'subs/en.m3u8'))}&s3=1"`);
      expect(calledUrls(f)).toEqual([s3(ZONE, 'manifest.m3u8')]);
    });

    it('an S3 variant sends its segments through /seg, flagged', async () => {
      gateways({ [s3(ZONE, '480p/index.m3u8')]: S3_VARIANT });
      const res = await request(app).get(`/hls?u=${enc(s3(ZONE, '480p/index.m3u8'))}&s3=1`);
      expect(res.text.split('\n')[3]).toBe(`${SELF}/seg/480p_0.ts?u=${enc(s3(ZONE, '480p/480p_0.ts'))}&s3=1`);
    });

    describe('strict=1: the assigned source only', () => {
      it('the zone manifest, children strict on the same host, segments direct (no /seg)', async () => {
        const f = gateways({ [s3(ZONE, 'manifest.m3u8')]: MASTER });
        const res = await request(app).get(`/hls?u=${enc(s3(ZONE, 'manifest.m3u8'))}&s3=1&strict=1`);
        expect(res.status).toBe(200);
        expect(res.headers['x-snapie-source']).toBe(s3(ZONE, 'manifest.m3u8'));
        expect(res.text.split('\n')[3]).toBe(`${SELF}/hls?u=${enc(s3(ZONE, '480p/index.m3u8'))}&s3=1&strict=1`);
        expect(calledUrls(f)).toEqual([s3(ZONE, 'manifest.m3u8')]);
        gateways({ [s3(ZONE, '480p/index.m3u8')]: S3_VARIANT });
        const variant = await request(app).get(`/hls?u=${enc(s3(ZONE, '480p/index.m3u8'))}&s3=1&strict=1`);
        expect(variant.text.split('\n')[3]).toBe(s3(ZONE, '480p/480p_0.ts'));
      });

      it('the zone refuses: 504, never the bucket direct or IPFS', async () => {
        const f = gateways({ [s3(ZONE, 'manifest.m3u8')]: 403, [s3(DIRECT, 'manifest.m3u8')]: MASTER, [at(BCDN, 'manifest.m3u8')]: MASTER });
        const res = await request(app).get(`/hls?u=${enc(s3(ZONE, 'manifest.m3u8'))}&s3=1&strict=1`);
        expect(res.status).toBe(504);
        expect(calledUrls(f)).toEqual([s3(ZONE, 'manifest.m3u8')]);
      });

      it('waits HLS_FETCH_TIMEOUT_MS, not the short S3 one, since there is nothing to move on to', async () => {
        gateways({ [s3(ZONE, 'manifest.m3u8')]: async () => { await delay(400); return text(MASTER); } });
        const res = await request(app).get(`/hls?u=${enc(s3(ZONE, 'manifest.m3u8'))}&strict=1`);
        expect(res.status).toBe(200);
      });

      it('an IPFS source: that gateway only, no race', async () => {
        const f = gateways({ [at(HOT, 'manifest.m3u8')]: 404, [at(BCDN, 'manifest.m3u8')]: MASTER, [s3(ZONE, 'manifest.m3u8')]: MASTER });
        const res = await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}&s3=1&strict=1`);
        expect(res.status).toBe(504);
        expect(calledUrls(f)).toEqual([at(HOT, 'manifest.m3u8')]);
      });

      it('a non-CORS source sends its children through a strict /ipfs-proxy', async () => {
        gateways({ [at(SUPER, '480p/index.m3u8')]: VARIANT });
        const res = await request(app).get(`/hls?u=${enc(at(SUPER, '480p/index.m3u8'))}&strict=1`);
        expect(res.text).toContain(`${SELF}/ipfs-proxy?u=${enc(at(SUPER, '480p/480p_0.ts'))}&strict=1`);
      });

      it('a gateway outside the list is not accepted as the source', async () => {
        installFetch();
        const res = await request(app).get(`/hls?u=${enc(`https://elsewhere.example/ipfs/${CID}/manifest.m3u8`)}&strict=1`);
        expect(res.status).toBe(400);
      });
    });

    it('the zone refuses (out of credit): plays from the bucket direct', async () => {
      const f = gateways({ [s3(ZONE, 'manifest.m3u8')]: 403, [s3(DIRECT, 'manifest.m3u8')]: MASTER });
      const res = await request(app).get(`/hls?u=${enc(s3(ZONE, 'manifest.m3u8'))}&s3=1`);
      expect(res.status).toBe(200);
      expect(res.text.split('\n')[3]).toBe(`${SELF}/hls?u=${enc(s3(DIRECT, '480p/index.m3u8'))}&s3=1`);
      expect(calledUrls(f)).toEqual([s3(ZONE, 'manifest.m3u8'), s3(DIRECT, 'manifest.m3u8')]);
    });

    it('the zone hangs: gives up after S3_FETCH_TIMEOUT_MS, not HLS_FETCH_TIMEOUT_MS', async () => {
      gateways({ [s3(ZONE, 'manifest.m3u8')]: hang, [s3(DIRECT, 'manifest.m3u8')]: MASTER });
      const started = Date.now();
      const res = await request(app).get(`/hls?u=${enc(s3(ZONE, 'manifest.m3u8'))}`);
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(900);
    });

    it('gone from S3: races the CORS IPFS gateways, children still flagged', async () => {
      const f = gateways({ [at(BCDN, 'manifest.m3u8')]: MASTER });
      const res = await request(app).get(`/hls?u=${enc(s3(ZONE, 'manifest.m3u8'))}`);
      expect(res.status).toBe(200);
      expect(res.text.split('\n')[3]).toBe(`${SELF}/hls?u=${enc(at(BCDN, '480p/index.m3u8'))}&s3=1`);
      // An archived video playing from IPFS says so: what the migrator's preview looks for.
      expect(res.headers['x-snapie-source']).toBe(at(BCDN, 'manifest.m3u8'));
      const asked = calledUrls(f);
      expect(asked.slice(0, 2)).toEqual([s3(ZONE, 'manifest.m3u8'), s3(DIRECT, 'manifest.m3u8')]);
      expect(asked).not.toContain(at(SUPER, 'manifest.m3u8'));
    });

    it('hot with an S3 copy: the hot zone first, then the S3 zone', async () => {
      const f = gateways({ [s3(ZONE, 'manifest.m3u8')]: MASTER });
      const res = await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}&s3=1`);
      expect(res.status).toBe(200);
      expect(res.text.split('\n')[3]).toBe(`${SELF}/hls?u=${enc(s3(ZONE, '480p/index.m3u8'))}&s3=1`);
      expect(calledUrls(f)).toEqual([at(HOT, 'manifest.m3u8'), s3(ZONE, 'manifest.m3u8')]);
    });

    it('hot without the flag never asks S3', async () => {
      const f = gateways({ [at(BCDN, 'manifest.m3u8')]: MASTER });
      await request(app).get(`/hls?u=${enc(at(HOT, 'manifest.m3u8'))}`);
      expect(calledUrls(f).some((u) => u.includes('videos-test'))).toBe(false);
    });

    it.each([
      ['an S3 path on another host', `https://evil.test/videos-test/${CID}/manifest.m3u8`],
      ['another bucket on s3.3speak.tv', `https://s3.3speak.tv/someone-else/${CID}/manifest.m3u8`],
      ['another bucket on the zone', `https://buttercloud.b-cdn.net/someone-else/${CID}/manifest.m3u8`],
      ['a path that climbs out of the bucket', `${DIRECT}/../someone-else/${CID}/manifest.m3u8`],
      ['an encoded climb', `${DIRECT}/%2e%2e/someone-else/${CID}/manifest.m3u8`],
      ['plain http', `http://s3.3speak.tv/videos-test/${CID}/manifest.m3u8`],
      ['another port', `https://s3.3speak.tv:8443/videos-test/${CID}/manifest.m3u8`],
      ['no file under the CID', `${DIRECT}/manifest.m3u8`],
    ])('400 for %s, asking nobody', async (_label, url) => {
      const f = installFetch();
      const res = await request(app).get(`/hls?u=${enc(url)}&s3=1`);
      expect(res.status).toBe(400);
      expect(f).not.toHaveBeenCalled();
    });
  });

  describe('GET /seg/:name', () => {
    it('an S3 zone segment that fails the probe goes to the bucket direct', async () => {
      const seg = s3(ZONE, '480p/s3-fb-0.ts');
      const alt = s3(DIRECT, '480p/s3-fb-0.ts');
      const f = installFetch((url) => (url === alt ? big() : text('', 403)));
      const res = await request(app).get(`/seg/s3-fb-0.ts?u=${enc(seg)}&s3=1`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(alt);
      expect(calledUrls(f)).toEqual([seg, alt]);
    });

    it('a segment already on the bucket direct is redirected without probing', async () => {
      const seg = s3(DIRECT, '480p/s3-direct-0.ts');
      const f = installFetch();
      const res = await request(app).get(`/seg/s3-direct-0.ts?u=${enc(seg)}&s3=1`);
      expect(res.headers.location).toBe(seg);
      expect(f).not.toHaveBeenCalled();
    });

    it('a hot segment of a video with an S3 copy falls back to the S3 zone, then direct', async () => {
      const seg = at(HOT, '480p/s3-hot-0.ts');
      const direct = s3(DIRECT, '480p/s3-hot-0.ts');
      const f = installFetch((url) => (url === direct ? big() : text('', 502)));
      const res = await request(app).get(`/seg/s3-hot-0.ts?u=${enc(seg)}&s3=1`);
      expect(res.headers.location).toBe(direct);
      expect(calledUrls(f)).toEqual([seg, s3(ZONE, '480p/s3-hot-0.ts'), direct]);
    });

    it('the flag is part of the cached decision', async () => {
      const seg = at(HOT, '480p/s3-key-0.ts');
      const zone = s3(ZONE, '480p/s3-key-0.ts');
      const audio = at(AUDIO, '480p/s3-key-0.ts');
      installFetch((url) => (url === zone || url === audio ? big() : text('', 502)));
      const flagged = await request(app).get(`/seg/x.ts?u=${enc(seg)}&s3=1`);
      const plain = await request(app).get(`/seg/x.ts?u=${enc(seg)}`);
      expect(flagged.headers.location).toBe(zone);
      expect(plain.headers.location).toBe(audio);
    });

    it.each([
      ['another bucket', `https://s3.3speak.tv/someone-else/${CID}/a.ts`],
      ['another host', `https://evil.test/videos-test/${CID}/a.ts`],
      ['an S3 playlist', s3(ZONE, '480p/index.m3u8')],
    ])('400 for %s', async (_label, url) => {
      installFetch();
      const res = await request(app).get(`/seg/a.ts?u=${enc(url)}&s3=1`);
      expect(res.status).toBe(400);
    });
  });
});
