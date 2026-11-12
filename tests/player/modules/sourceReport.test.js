import { describe, it, expect, vi } from 'vitest';
import { describeResponse, installSourceReport, setReportContext, SOURCE_MESSAGE } from '../../../src/sourceReport.js';

const SELF = 'https://play.test';
const CID = 'QmRSjgN5L4ypwqLYANPALx6Eo4xRr4iGg9xZM1kKdKYgBM';
const ZONE = `https://buttercloud.b-cdn.net/videos-test/${CID}`;
const enc = encodeURIComponent;

// What VHS hands a response hook: the XHR and @videojs/xhr's response object.
const xhr = (responseURL, { status = 200, headers = {} } = {}) => [
  { responseURL, status, getResponseHeader: (n) => headers[n] ?? null },
  { statusCode: status, headers, url: responseURL, responseUrl: responseURL },
];

const describeUrl = (url, opts, error = null) => { const [req, res] = xhr(url, opts); return describeResponse(req, error, res, SELF); };

describe('describeResponse', () => {
  it('a /hls playlist reports the source the server named', () => {
    const [req, res] = xhr(`${SELF}/hls?u=${enc(`${ZONE}/manifest.m3u8`)}&s3=1`, {
      headers: { 'x-snapie-source': 'https://ipfs-3speak.b-cdn.net/ipfs/x/manifest.m3u8' },
    });
    expect(describeResponse(req, null, res, SELF)).toEqual({
      kind: 'playlist', url: 'https://ipfs-3speak.b-cdn.net/ipfs/x/manifest.m3u8', proxied: true, confirmed: true, ok: true, status: 200,
    });
  });

  it('a /hls playlist without the header falls back to u=, unconfirmed', () => {
    const [req, res] = xhr(`${SELF}/hls/manifest.m3u8?u=${enc(`${ZONE}/480p/index.m3u8`)}`);
    expect(describeResponse(req, null, res, SELF)).toMatchObject({ kind: 'playlist', url: `${ZONE}/480p/index.m3u8`, confirmed: false });
  });

  it('reads the header from the XHR when the response object has none', () => {
    const req = { responseURL: `${SELF}/hls?u=x`, status: 200, getResponseHeader: (n) => (n === 'x-snapie-source' ? 'https://a.test/ipfs/q' : null) };
    expect(describeResponse(req, null, { statusCode: 200 }, SELF).url).toBe('https://a.test/ipfs/q');
    const throws = { responseURL: `${SELF}/hls?u=x`, status: 200, getResponseHeader: () => { throw new Error('unsafe header'); } };
    expect(describeResponse(throws, null, { statusCode: 200 }, SELF)).toMatchObject({ url: 'x', confirmed: false });
  });

  it('a /seg segment reports where the redirect landed', () => {
    const [req, res] = xhr(`${ZONE}/480p/480p_3.ts`);
    expect(describeResponse(req, null, res, SELF)).toEqual({
      kind: 'segment', url: `${ZONE}/480p/480p_3.ts`, proxied: false, confirmed: true, ok: true, status: 200,
    });
  });

  it('a segment that never left /seg is a failure on its upstream, unconfirmed', () => {
    const [req, res] = xhr(`${SELF}/seg/480p_3.ts?u=${enc(`${ZONE}/480p/480p_3.ts`)}`, { status: 502 });
    expect(describeResponse(req, new Error('x'), res, SELF)).toMatchObject({ kind: 'segment', url: `${ZONE}/480p/480p_3.ts`, confirmed: false, ok: false, status: 502 });
  });

  it('/ipfs-proxy bytes are proxied, from the gateway in u=', () => {
    const [req, res] = xhr(`${SELF}/ipfs-proxy?u=${enc('https://ipfs.3speak.tv/ipfs/q/1.ts')}`);
    expect(describeResponse(req, null, res, SELF)).toMatchObject({ kind: 'segment', url: 'https://ipfs.3speak.tv/ipfs/q/1.ts', proxied: true });
  });

  it('a direct URL is a playlist or a segment by its extension', () => {
    expect(describeUrl('https://gw.test/ipfs/q/manifest.m3u8').kind).toBe('playlist');
    expect(describeUrl('https://gw.test/ipfs/q/1.ts', { status: 206 })).toMatchObject({ kind: 'segment', ok: true });
  });

  it('a timeout or a 404 is not ok', () => {
    expect(describeUrl('https://gw.test/ipfs/q/1.ts', { status: 404 }).ok).toBe(false);
    expect(describeUrl('https://gw.test/ipfs/q/1.ts', {}, new Error('timeout')).ok).toBe(false);
    expect(describeUrl('https://gw.test/ipfs/q/1.ts').ok).toBe(true);
  });

  it('falls back to request.uri, and gives up on nothing usable', () => {
    expect(describeResponse({ uri: '/hls?u=abc' }, null, undefined, SELF)).toMatchObject({ kind: 'playlist', url: 'abc', status: 0, ok: false });
    expect(describeResponse({}, null, {}, undefined)).toBeNull();
  });
});

describe('installSourceReport', () => {
  const fakeVhs = () => {
    const hooks = [];
    return { hooks, xhr: { onResponse: (cb) => hooks.push(cb) } };
  };

  it('posts one message per response, tagged 3speak-source', () => {
    const Vhs = fakeVhs();
    const post = vi.fn();
    expect(installSourceReport(Vhs, post, SELF)).toBe(true);
    const call = (url) => { const [req, res] = xhr(url); Vhs.hooks[0](req, null, res); };
    call(`${ZONE}/480p/480p_0.ts`);
    call(`${ZONE}/480p/480p_1.ts`);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toMatchObject({ type: SOURCE_MESSAGE, kind: 'segment', url: `${ZONE}/480p/480p_1.ts` });
  });

  it('every report carries the playback context (strict), false until it is set', () => {
    const Vhs = fakeVhs();
    const post = vi.fn();
    installSourceReport(Vhs, post, SELF);
    const call = (url) => { const [req, res] = xhr(url); Vhs.hooks[0](req, null, res); };
    call(`${ZONE}/480p/480p_0.ts`);
    setReportContext({ strict: true });
    call(`${ZONE}/480p/480p_1.ts`);
    expect(post.mock.calls.map((c) => c[0].strict)).toEqual([false, true]);
    setReportContext({ strict: false });
  });

  it('installs once per VHS, and not at all without the hook API', () => {
    const Vhs = fakeVhs();
    installSourceReport(Vhs, vi.fn(), SELF);
    expect(installSourceReport(Vhs, vi.fn(), SELF)).toBe(false);
    expect(Vhs.hooks).toHaveLength(1);
    expect(installSourceReport(undefined, vi.fn(), SELF)).toBe(false);
    expect(installSourceReport({ xhr: {} }, vi.fn(), SELF)).toBe(false);
  });

  it('never throws into VHS, and skips reports without a URL', () => {
    const Vhs = fakeVhs();
    const post = vi.fn(() => { throw new Error('parent gone'); });
    installSourceReport(Vhs, post, SELF);
    const call = (url) => { const [req, res] = xhr(url); Vhs.hooks[0](req, null, res); };
    expect(() => call(`${ZONE}/1.ts`)).not.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    post.mockClear();
    call(`${SELF}/ipfs-proxy`);   // no u=
    expect(post).not.toHaveBeenCalled();
  });
});
