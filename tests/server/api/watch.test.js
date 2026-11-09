// GET /api/watch: legacy `videos` first, then the embed collection.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../../helpers/mongo.js';
import { loadServer, stopServer, serverDb } from './_helpers/loadServer.js';
import { installFetch, calledUrls, json, delay, hiveParams, hivePost } from './_helpers/fakeFetch.js';
import { seedLegacy, seedEmbed, CID, HOT, SELF, viaHls } from './_helpers/fixtures.js';

const MASTER = `${HOT}/${CID}/manifest.m3u8`;
const TIMELINE_META = {
  video: {
    chapters: [{ start: 30, title: 'Setup' }, { start: 0, title: 'Intro' }],
    links: [{ at: 10, kind: 'profile', account: 'badadib' }],
  },
};
const SANITISED = {
  chapters: [{ start: 0, title: 'Intro' }, { start: 30, title: 'Setup' }],
  links: [{ at: 10, dur: 8, kind: 'profile', account: 'badadib' }],
};

let app;
let fetchMock;
// Per test: what the fake Hive node answers, keyed by "author/permlink".
let hivePosts;

beforeAll(async () => { app = await loadServer(); });
afterAll(async () => { await stopServer(); await closeTestDb(); });
beforeEach(async () => {
  await resetDb();
  hivePosts = {};
  fetchMock = installFetch(async (url, init) => {
    if (url !== 'https://hive.test') return undefined;
    const [author, permlink] = hiveParams(init);
    const answer = hivePosts[`${author}/${permlink}`];
    if (typeof answer === 'function') return answer();
    if (answer) return hivePost(author, permlink, answer);
    return json({ result: { author: '', permlink: '' } });
  });
});

const hiveCalls = () => fetchMock.mock.calls
  .filter(([u]) => u === 'https://hive.test')
  .map(([, init]) => hiveParams(init).join('/'));

describe('GET /api/watch: request validation', () => {
  it('400 without v', async () => {
    const res = await request(app).get('/api/watch');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing video parameter (v)' });
  });

  it('400 when v is not owner/permlink', async () => {
    const res = await request(app).get('/api/watch?v=badadib');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid video format. Expected: owner/permlink' });
  });

  it('a repeated v parameter answers 400, not a 500 crash', async () => {
    const res = await request(app).get('/api/watch?v=badadib/a&v=badadib/b');
    expect(res.status).toBe(400);
  });

  it('404 when neither collection has the video', async () => {
    const res = await request(app).get('/api/watch?v=badadib/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not found' });
  });

  it('answers with CORS open to every origin', async () => {
    const res = await request(app).get('/api/watch?v=badadib/nothing-here').set('Origin', 'https://site.test');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('GET /api/watch: legacy video, web player response', () => {
  it('returns the full legacy payload with the manifest routed through /hls', async () => {
    await seedLegacy({ permlink: 'legacy-one' });
    const res = await request(app).get('/api/watch?v=badadib/legacy-one');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({
      success: true,
      type: 'legacy',
      owner: 'badadib',
      permlink: 'legacy-one',
      title: 'A legacy video',
      description: 'About it',
      status: 'published',
      isPlaceholder: false,
      thumbnail: 'https://gw.test/ipfs/QmLegacyThumb',
      videoUrl: viaHls(MASTER),
      videoUrlFallback1: viaHls(MASTER),
      videoUrlFallback2: viaHls(MASTER),
      videoUrlFallback3: viaHls(MASTER),
      duration: 120,
      views: 7,
      tags: ['hive', 'video'],
      timeline: null,
    });
  });

  it('fills defaults for a sparse row', async () => {
    await seedLegacy({
      permlink: 'sparse', title: undefined, description: undefined, thumbnail: undefined,
      duration: undefined, views: undefined, tags_v2: undefined, tags: ['old-tag'],
    });
    const res = await request(app).get('/api/watch?v=badadib/sparse');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: 'Untitled Video',
      description: '',
      thumbnail: 'https://gw.test/ipfs/QmDefaultThumb',
      duration: 0,
      views: 0,
      tags: ['old-tag'],
    });
  });

  it('passes a non-HLS https source through unchanged', async () => {
    await seedLegacy({ permlink: 'mp4-file', video_v2: 'https://files.test/v.mp4', tags_v2: undefined });
    const res = await request(app).get('/api/watch?v=badadib/mp4-file');
    expect(res.body.videoUrl).toBe('https://files.test/v.mp4');
    expect(res.body.videoUrlFallback3).toBe('https://files.test/v.mp4');
    expect(res.body.tags).toEqual([]);
  });

  it.each(['publish_later', 'publish_manual', 'scheduled', 'PUBLISHED'])('serves the video for status %s', async (status) => {
    await seedLegacy({ permlink: `ready-${status.toLowerCase()}`, status });
    const res = await request(app).get(`/api/watch?v=badadib/ready-${status.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.isPlaceholder).toBe(false);
    expect(res.body.videoUrl).toBe(viaHls(MASTER));
  });

  it('404 for a ready status without a source', async () => {
    await seedLegacy({ permlink: 'no-source', video_v2: undefined });
    const res = await request(app).get('/api/watch?v=badadib/no-source');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video source not available', status: 'published' });
  });

  it('404 for an unknown status', async () => {
    await seedLegacy({ permlink: 'odd-status', status: 'banned' });
    const res = await request(app).get('/api/watch?v=badadib/odd-status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video source not available', status: 'banned' });
  });

  it('404 for a row with no status at all', async () => {
    await seedLegacy({ permlink: 'no-status', status: undefined });
    const res = await request(app).get('/api/watch?v=badadib/no-status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video source not available' });
  });
});

describe('GET /api/watch: legacy placeholders', () => {
  const cases = [
    ['deleted', 'QmDeleted'], ['delete', 'QmDeleted'], ['self_deleted', 'QmDeleted'],
    ['encoding_ipfs', 'QmProcessing'], ['ipfs_pinning', 'QmProcessing'], ['uploaded', 'QmProcessing'],
    ['encoding_failed', 'QmFailed'], ['failed', 'QmFailed'],
  ];
  it.each(cases)('status %s plays the %s notice clip', async (status, cid) => {
    await seedLegacy({ permlink: `ph-${status}`, status });
    const res = await request(app).get(`/api/watch?v=badadib/ph-${status}`);
    expect(res.status).toBe(200);
    const clip = viaHls(`https://gw.test/ipfs/${cid}/manifest.m3u8`);
    expect(res.body).toMatchObject({ isPlaceholder: true, status, videoUrl: clip, videoUrlFallback2: clip, timeline: null });
    expect(res.body.timelinePending).toBeUndefined();
  });

  it.each([
    ['deleted', 'PLACEHOLDER_DELETED_CID'],
    ['uploaded', 'PLACEHOLDER_PROCESSING_CID'],
    ['failed', 'PLACEHOLDER_FAILED_CID'],
  ])('404 "Placeholder configuration error" for %s when %s is blank', async (status, envName) => {
    vi.stubEnv(envName, '');
    await seedLegacy({ permlink: `cfg-${status}`, status });
    const res = await request(app).get(`/api/watch?v=badadib/cfg-${status}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Placeholder configuration error', status });
  });

  it('an unset placeholder CID answers 404 "Placeholder configuration error", not a 500', async () => {
    vi.stubEnv('PLACEHOLDER_DELETED_CID', undefined);
    await seedLegacy({ permlink: 'cfg-unset', status: 'deleted' });
    const res = await request(app).get('/api/watch?v=badadib/cfg-unset');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Placeholder configuration error', status: 'deleted' });
  });
});

describe('GET /api/watch: mobile info response (info=true)', () => {
  it('legacy: cid on the .m3u8 /hls route, CDN thumbnail, views', async () => {
    await seedLegacy({ permlink: 'info-legacy' });
    const res = await request(app).get('/api/watch?v=badadib/info-legacy&info=true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cid: viaHls(MASTER, 'hls/manifest.m3u8'),
      thumbnail: `${HOT}/QmLegacyThumb`,
      views: 7,
    });
  });

  it('legacy: never asks Hive for a timeline', async () => {
    await seedLegacy({ permlink: 'info-no-hive' });
    await request(app).get('/api/watch?v=badadib/info-no-hive&info=true');
    expect(hiveCalls()).toEqual([]);
  });

  it.each([
    ['https://img.test/t.jpg', 'https://img.test/t.jpg'],
    ['QmBareThumb', `${HOT}/QmBareThumb`],
    [undefined, `${HOT}/QmDefaultThumb`],
  ])('legacy thumbnail %s becomes %s', async (thumbnail, want) => {
    await seedLegacy({ permlink: 'info-thumb', thumbnail, views: undefined });
    const res = await request(app).get('/api/watch?v=badadib/info-thumb&info=true');
    expect(res.body.thumbnail).toBe(want);
    expect(res.body.views).toBe(0);
  });

  it('legacy: a bare CID source gets the CDN manifest path', async () => {
    await seedLegacy({ permlink: 'info-bare', video_v2: 'QmBareVideo' });
    const res = await request(app).get('/api/watch?v=badadib/info-bare&info=true');
    expect(res.body.cid).toBe(viaHls(`${HOT}/QmBareVideo/manifest.m3u8`, 'hls/manifest.m3u8'));
  });

  it('embed fallback: adds short and story fields', async () => {
    const at = new Date(Date.now() + 3600e3);
    await seedEmbed({ permlink: 'info-embed', short: true, story: true, story_expires_at: at, thumbnail_url: 'ipfs://QmEmbedThumb' });
    const res = await request(app).get('/api/watch?v=badadib/info-embed&info=true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cid: viaHls(MASTER, 'hls/manifest.m3u8'),
      thumbnail: `${HOT}/QmEmbedThumb`,
      views: 3,
      short: true,
      story: true,
      storyExpiresAt: at.toISOString(),
      storyExpired: false,
    });
  });

  it('embed fallback: an expired story shows the bundled poster and clip', async () => {
    await seedEmbed({ permlink: 'info-gone', story: true, story_expires_at: new Date(Date.now() - 1000) });
    const res = await request(app).get('/api/watch?v=badadib/info-gone&info=true');
    expect(res.body).toMatchObject({
      cid: `${SELF}/assets/story-expired-v2/manifest.m3u8`,
      thumbnail: `${SELF}/assets/story-expired-v2.jpg`,
      short: false,
      story: true,
      storyExpired: true,
    });
  });
});

describe('GET /api/watch: embed fallback, web player response', () => {
  it('returns the embed payload when no legacy row exists', async () => {
    await seedEmbed({ permlink: 'embed-one', hive_permlink: 'embed-one' });
    const res = await request(app).get('/api/watch?v=badadib/embed-one');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      type: 'embed',
      owner: 'badadib',
      permlink: 'embed-one',
      hivePermlink: 'embed-one',
      title: 'clip.mp4',
      status: 'published',
      isPlaceholder: false,
      videoUrl: viaHls(MASTER),
      videoUrlFallback1: viaHls(MASTER),
      videoUrlFallback2: viaHls(MASTER),
      videoUrlFallback3: viaHls(MASTER),
      thumbnail: 'https://img.test/thumb.jpg',
      duration: 60,
      views: 3,
      short: false,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:05:00.000Z',
      encodingProgress: 100,
      timeline: null,
    });
  });

  it('the legacy row wins over an embed row with the same id', async () => {
    await seedLegacy({ permlink: 'both' });
    await seedEmbed({ permlink: 'both' });
    const res = await request(app).get('/api/watch?v=badadib/both');
    expect(res.body.type).toBe('legacy');
  });

  it('finds the embed by its Hive permlink', async () => {
    await seedEmbed({ permlink: 'asset-abc', hive_permlink: 'my-post' });
    const res = await request(app).get('/api/watch?v=badadib/my-post');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ permlink: 'asset-abc', hivePermlink: 'my-post' });
  });

  it('defaults title, thumbnail, counters and hivePermlink', async () => {
    await seedEmbed({
      permlink: 'bare-embed', originalFilename: undefined, thumbnail_url: undefined,
      duration: undefined, views: undefined, short: undefined, encodingProgress: undefined,
    });
    const res = await request(app).get('/api/watch?v=badadib/bare-embed');
    expect(res.body).toMatchObject({
      title: 'badadib/bare-embed',
      thumbnail: 'https://gw.test/ipfs/QmDefaultThumb',
      hivePermlink: null,
      duration: 0,
      views: 0,
      short: false,
      encodingProgress: 0,
    });
  });

  it('an expired story plays the bundled clip without the /hls detour', async () => {
    await seedEmbed({ permlink: 'old-story', story: true, story_expires_at: new Date(Date.now() - 60e3) });
    const res = await request(app).get('/api/watch?v=badadib/old-story');
    expect(res.body).toMatchObject({
      isPlaceholder: true,
      videoUrl: `${SELF}/assets/story-expired-v2/manifest.m3u8`,
      thumbnail: `${SELF}/assets/story-expired-v2.jpg`,
      story: true,
      storyExpired: true,
      timeline: null,
    });
  });

  it('404 "Video not ready" for an embed that is published without a manifest', async () => {
    await seedEmbed({ permlink: 'no-manifest', manifest_cid: undefined });
    const res = await request(app).get('/api/watch?v=badadib/no-manifest');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not ready', status: 'published' });
  });
});

describe('GET /api/watch: creator timeline from Hive', () => {
  it('includes the sanitised timeline when Hive answers in time', async () => {
    hivePosts['badadib/with-chapters'] = TIMELINE_META;
    await seedLegacy({ permlink: 'with-chapters' });
    const res = await request(app).get('/api/watch?v=badadib/with-chapters');
    expect(res.body.timeline).toEqual(SANITISED);
    expect(res.body.timelinePending).toBeUndefined();
    const [url, init] = fetchMock.mock.calls.find(([u]) => u === 'https://hive.test');
    expect(url).toBe('https://hive.test');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      jsonrpc: '2.0', method: 'condenser_api.get_content', params: ['badadib', 'with-chapters'], id: 1,
    });
  });

  it('reads the timeline of the Hive post an embed asset belongs to', async () => {
    hivePosts['badadib/the-post'] = TIMELINE_META;
    await seedEmbed({ permlink: 'asset-77', hive_permlink: 'the-post' });
    const res = await request(app).get('/api/watch?v=badadib/asset-77');
    expect(res.body.timeline).toEqual(SANITISED);
    // The early lookup for the requested id, then the doc's own post.
    expect(hiveCalls()).toEqual(['badadib/asset-77', 'badadib/the-post']);
  });

  it('caches a lookup, so a second request does not ask Hive again', async () => {
    hivePosts['badadib/cached-post'] = TIMELINE_META;
    await seedLegacy({ permlink: 'cached-post' });
    await request(app).get('/api/watch?v=badadib/cached-post');
    const res = await request(app).get('/api/watch?v=badadib/cached-post');
    expect(res.body.timeline).toEqual(SANITISED);
    expect(hiveCalls()).toEqual(['badadib/cached-post']);
  });

  it('skips Hive entirely for an owner that is not a Hive account name', async () => {
    await seedLegacy({ owner: 'Not_A_Hive_Name', permlink: 'x-1' });
    const res = await request(app).get('/api/watch?v=Not_A_Hive_Name/x-1');
    expect(res.status).toBe(200);
    expect(res.body.timeline).toBeNull();
    expect(calledUrls(fetchMock)).toEqual([]);
  });

  it.each([
    ['a Hive error', () => json({ error: { message: 'boom' } })],
    ['an HTTP 503', () => json({}, 503)],
    ['metadata that is not JSON', () => hivePost('badadib', 'p', '{not json')],
    ['a network failure', () => { throw new Error('ECONNRESET'); }],
  ])('a timeline of null on %s', async (_label, answer) => {
    const permlink = `tl-fail-${Math.random().toString(36).slice(2, 8)}`;
    hivePosts[`badadib/${permlink}`] = answer;
    await seedLegacy({ permlink });
    const res = await request(app).get(`/api/watch?v=badadib/${permlink}`);
    expect(res.status).toBe(200);
    expect(res.body.timeline).toBeNull();
    expect(res.body.timelinePending).toBeUndefined();
  });

  it('does not wait for a slow Hive node: timelinePending, then /api/timeline has it', async () => {
    hivePosts['badadib/slow-post'] = async () => { await delay(900); return hivePost('badadib', 'slow-post', TIMELINE_META); };
    await seedLegacy({ permlink: 'slow-post' });
    const t0 = Date.now();
    const res = await request(app).get('/api/watch?v=badadib/slow-post');
    expect(Date.now() - t0).toBeLessThan(900);
    expect(res.body).toMatchObject({ timeline: null, timelinePending: true, timelinePost: 'badadib/slow-post' });

    const later = await request(app).get('/api/timeline?post=badadib/slow-post');
    expect(later.status).toBe(200);
    expect(later.headers['cache-control']).toBe('public, max-age=300');
    expect(later.body).toEqual({ timeline: SANITISED });
    expect(hiveCalls()).toEqual(['badadib/slow-post']);
  });
});

describe('GET /api/watch: database failure', () => {
  it('500 with a generic error when Mongo is unavailable', async () => {
    const db = serverDb();
    await db.close();
    try {
      const res = await request(app).get('/api/watch?v=badadib/anything');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    } finally {
      await db.connect();
    }
  });
});
