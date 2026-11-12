// GET /api/embed (embed-video collection only) and GET /api/timeline.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { resetDb, closeTestDb } from '../../helpers/mongo.js';
import { loadServer, stopServer, serverDb } from './_helpers/loadServer.js';
import { installFetch, json, hiveParams, hivePost } from './_helpers/fakeFetch.js';
import { seedLegacy, seedEmbed, CID, HOT, SELF, viaHls } from './_helpers/fixtures.js';

const MASTER = `${HOT}/${CID}/manifest.m3u8`;
const STORY_CLIP = `${SELF}/assets/story-expired-v2/manifest.m3u8`;
const STORY_POSTER = `${SELF}/assets/story-expired-v2.jpg`;

let app;
let fetchMock;
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

describe('GET /api/embed: request validation', () => {
  it('400 without v', async () => {
    const res = await request(app).get('/api/embed');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing video parameter (v)' });
  });

  it('400 when v has no permlink', async () => {
    const res = await request(app).get('/api/embed?v=badadib/');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid video format. Expected: owner/permlink' });
  });

  it('400 for a repeated v parameter', async () => {
    const res = await request(app).get('/api/embed?v=badadib/a&v=badadib/b');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid video format. Expected: owner/permlink' });
  });

  it('404 for a video that only exists in the legacy collection', async () => {
    await seedLegacy({ permlink: 'legacy-only' });
    const res = await request(app).get('/api/embed?v=badadib/legacy-only');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not found' });
  });
});

describe('GET /api/embed: published video', () => {
  it('returns the player payload, cacheable for five minutes', async () => {
    await seedEmbed({ permlink: 'clip-1', hive_permlink: 'clip-1', short: true });
    const res = await request(app).get('/api/embed?v=badadib/clip-1');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.body).toEqual({
      success: true,
      type: 'embed',
      owner: 'badadib',
      permlink: 'clip-1',
      hivePermlink: 'clip-1',
      title: 'clip.mp4',
      status: 'published',
      isPlaceholder: false,
      strict: false,
      videoUrl: viaHls(MASTER),
      videoUrlFallback1: viaHls(MASTER),
      videoUrlFallback2: viaHls(MASTER),
      videoUrlFallback3: viaHls(MASTER),
      thumbnail: 'https://img.test/thumb.jpg',
      duration: 60,
      views: 3,
      short: true,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:05:00.000Z',
      encodingProgress: 100,
      timeline: null,
    });
  });

  it('falls back to the default thumbnail and a generated title', async () => {
    await seedEmbed({ permlink: 'bare', thumbnail_url: undefined, originalFilename: undefined, short: undefined });
    const res = await request(app).get('/api/embed?v=badadib/bare');
    expect(res.body).toMatchObject({
      thumbnail: 'https://gw.test/ipfs/QmDefaultThumb',
      title: 'badadib/bare',
      hivePermlink: null,
      short: false,
    });
  });

  it('resolves a Hive permlink to its asset', async () => {
    await seedEmbed({ permlink: 'asset-9', hive_permlink: 'hive-post-9' });
    const res = await request(app).get('/api/embed?v=badadib/hive-post-9');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ permlink: 'asset-9', hivePermlink: 'hive-post-9' });
  });

  it('resolves an asset stored under a broken owner by its Hive link', async () => {
    await seedEmbed({ owner: 'null', permlink: 'tus-123', hive_author: 'badadib', hive_permlink: 'my-upload' });
    const res = await request(app).get('/api/embed?v=badadib/my-upload');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ owner: 'null', permlink: 'tus-123' });
  });

  it('carries the timeline of the asset\'s Hive post', async () => {
    hivePosts['viewer1/post-with-links'] = {
      video: { links: [{ at: 5, kind: 'url', url: 'https://www.example.com/a', title: 'Site', site: '3speak.tv' }] },
    };
    await seedEmbed({ owner: 'badadib', permlink: 'asset-x', hive_author: 'viewer1', hive_permlink: 'post-with-links' });
    const res = await request(app).get('/api/embed?v=badadib/asset-x');
    expect(res.body.timeline).toEqual({
      chapters: [],
      links: [{ at: 5, dur: 8, kind: 'url', url: 'https://www.example.com/a', site: 'example.com', title: 'Site' }],
    });
    expect(hiveCalls()).toEqual(['badadib/asset-x', 'viewer1/post-with-links']);
  });

  it('reuses the early lookup when the asset is keyed by its Hive post', async () => {
    hivePosts['badadib/same-post'] = { video: { chapters: [{ start: 0, title: 'Start' }] } };
    await seedEmbed({ permlink: 'same-post', hive_permlink: 'same-post' });
    const res = await request(app).get('/api/embed?v=badadib/same-post');
    expect(res.body.timeline).toEqual({ chapters: [{ start: 0, title: 'Start' }], links: [] });
    expect(hiveCalls()).toEqual(['badadib/same-post']);
  });
});

describe('GET /api/embed: not yet playable', () => {
  it.each([
    ['uploading', 'QmProcessing'], ['processing', 'QmProcessing'], ['finalizing', 'QmProcessing'],
    ['encoding_ipfs', 'QmProcessing'], ['ipfs_pinning', 'QmProcessing'], ['uploaded', 'QmProcessing'],
    ['deleted', 'QmDeleted'], ['self_deleted', 'QmDeleted'], ['delete', 'QmDeleted'],
    ['encoding_failed', 'QmFailed'], ['failed', 'QmFailed'],
  ])('status %s plays the %s notice, never cached', async (status, cid) => {
    await seedEmbed({ permlink: `ph-${status}`, status, encodingProgress: 40 });
    const res = await request(app).get(`/api/embed?v=badadib/ph-${status}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const clip = viaHls(`https://gw.test/ipfs/${cid}/manifest.m3u8`);
    expect(res.body).toMatchObject({ isPlaceholder: true, status, videoUrl: clip, videoUrlFallback3: clip, encodingProgress: 40, timeline: null });
  });

  it('a placeholder still answers even when the manifest exists', async () => {
    await seedEmbed({ permlink: 'del-with-cid', status: 'deleted' });
    const res = await request(app).get('/api/embed?v=badadib/del-with-cid');
    expect(res.body.videoUrl).toBe(viaHls('https://gw.test/ipfs/QmDeleted/manifest.m3u8'));
  });

  it('404 "Video not ready" for an unknown status', async () => {
    await seedEmbed({ permlink: 'weird', status: 'quarantined' });
    const res = await request(app).get('/api/embed?v=badadib/weird');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not ready', status: 'quarantined' });
  });

  it('404 "Video not ready" for a row without a status', async () => {
    await seedEmbed({ permlink: 'no-status', status: undefined });
    const res = await request(app).get('/api/embed?v=badadib/no-status');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not ready' });
  });

  it('404 "Placeholder configuration error" when the notice CID is blank', async () => {
    process.env.PLACEHOLDER_FAILED_CID = '';
    try {
      await seedEmbed({ permlink: 'cfg', status: 'failed' });
      const res = await request(app).get('/api/embed?v=badadib/cfg');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Placeholder configuration error', status: 'failed' });
    } finally {
      process.env.PLACEHOLDER_FAILED_CID = 'ipfs://QmFailed/manifest.m3u8';
    }
  });
});

describe('GET /api/embed: 24h stories', () => {
  it('a live story reports its expiry and is cached no longer than it lives', async () => {
    const at = new Date(Date.now() + 120_500);
    await seedEmbed({ permlink: 'story-live', short: true, story: true, story_expires_at: at });
    const res = await request(app).get('/api/embed?v=badadib/story-live');
    expect(res.status).toBe(200);
    const maxAge = Number(res.headers['cache-control'].match(/^public, max-age=(\d+)$/)[1]);
    expect(maxAge).toBeGreaterThanOrEqual(110);
    expect(maxAge).toBeLessThanOrEqual(120);
    expect(res.body).toMatchObject({
      isPlaceholder: false,
      strict: false,
      videoUrl: viaHls(MASTER),
      story: true,
      storyExpiresAt: at.toISOString(),
      storyExpired: false,
    });
  });

  it('a story with more than five minutes left keeps the normal max-age', async () => {
    await seedEmbed({ permlink: 'story-long', story: true, story_expires_at: new Date(Date.now() + 3600e3) });
    const res = await request(app).get('/api/embed?v=badadib/story-long');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('an expired story plays the bundled clip and poster, uncached', async () => {
    await seedEmbed({ permlink: 'story-gone', story: true, story_expires_at: new Date(Date.now() - 5000).toISOString() });
    const res = await request(app).get('/api/embed?v=badadib/story-gone');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      isPlaceholder: true,
      videoUrl: STORY_CLIP,
      videoUrlFallback1: STORY_CLIP,
      thumbnail: STORY_POSTER,
      story: true,
      storyExpired: true,
      timeline: null,
    });
  });

  it('PLACEHOLDER_STORY_EXPIRED_CID overrides the bundled clip', async () => {
    process.env.PLACEHOLDER_STORY_EXPIRED_CID = 'ipfs://QmStoryGone/manifest.m3u8';
    try {
      await seedEmbed({ permlink: 'story-cid', story: true, story_expires_at: new Date(Date.now() - 5000) });
      const res = await request(app).get('/api/embed?v=badadib/story-cid');
      expect(res.body.videoUrl).toBe(viaHls('https://gw.test/ipfs/QmStoryGone/manifest.m3u8'));
    } finally {
      delete process.env.PLACEHOLDER_STORY_EXPIRED_CID;
    }
  });

  it('a deleted story shows the deletion notice, not the expiry clip', async () => {
    await seedEmbed({ permlink: 'story-del', status: 'deleted', story: true, story_expires_at: new Date(Date.now() - 5000) });
    const res = await request(app).get('/api/embed?v=badadib/story-del');
    expect(res.body.videoUrl).toBe(viaHls('https://gw.test/ipfs/QmDeleted/manifest.m3u8'));
    expect(res.body.thumbnail).toBe(STORY_POSTER);
  });

  it.each([
    ['no expiry date', { story: true }],
    ['an unreadable expiry date', { story: true, story_expires_at: 'not-a-date' }],
    ['story not set to true', { story: 'yes', story_expires_at: new Date(Date.now() - 5000) }],
  ])('a row with %s is not treated as a story', async (_label, fields) => {
    await seedEmbed({ permlink: 'not-story', ...fields });
    const res = await request(app).get('/api/embed?v=badadib/not-story');
    expect(res.body.isPlaceholder).toBe(false);
    expect(res.body.story).toBeUndefined();
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });
});

describe('GET /api/embed: mobile info response (info=true)', () => {
  it('returns cid, thumbnail, short and views only', async () => {
    await seedEmbed({ permlink: 'mob', short: true, thumbnail_url: 'ipfs://QmMobThumb' });
    const res = await request(app).get('/api/embed?v=badadib/mob&info=true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      cid: viaHls(MASTER, 'hls/manifest.m3u8'),
      thumbnail: `${HOT}/QmMobThumb`,
      short: true,
      views: 3,
    });
    expect(hiveCalls()).toEqual([]);
  });

  it('a processing video hands out the processing clip', async () => {
    await seedEmbed({ permlink: 'mob-proc', status: 'encoding_ipfs', thumbnail_url: undefined, views: undefined });
    const res = await request(app).get('/api/embed?v=badadib/mob-proc&info=true');
    expect(res.body).toEqual({
      cid: viaHls('https://gw.test/ipfs/QmProcessing/manifest.m3u8', 'hls/manifest.m3u8'),
      thumbnail: `${HOT}/QmDefaultThumb`,
      short: false,
      views: 0,
    });
  });

  it('an expired story hands out the bundled clip and poster', async () => {
    const at = new Date(Date.now() - 1000);
    await seedEmbed({ permlink: 'mob-story', story: true, story_expires_at: at });
    const res = await request(app).get('/api/embed?v=badadib/mob-story&info=true');
    expect(res.body).toEqual({
      cid: STORY_CLIP,
      thumbnail: STORY_POSTER,
      short: false,
      views: 3,
      story: true,
      storyExpiresAt: at.toISOString(),
      storyExpired: true,
    });
  });

  it('404 for an unknown status', async () => {
    await seedEmbed({ permlink: 'mob-odd', status: 'quarantined' });
    const res = await request(app).get('/api/embed?v=badadib/mob-odd&info=true');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/embed: storage_state (S3 archive)', () => {
  const S3_DIRECT = `https://s3.3speak.tv/videos-test/${CID}/manifest.m3u8`;
  const S3_ZONE = `https://buttercloud.b-cdn.net/videos-test/${CID}/manifest.m3u8`;

  it('archived: plays from the S3 zone, web and mobile', async () => {
    await seedEmbed({ permlink: 's3-clip', storage_state: 'archived', s3_url: S3_DIRECT });
    const web = await request(app).get('/api/embed?v=badadib/s3-clip');
    expect(web.body.videoUrl).toBe(`${viaHls(S3_ZONE)}&s3=1`);
    expect(web.body.videoUrlFallback1).toBe(web.body.videoUrl);
    const info = await request(app).get('/api/embed?v=badadib/s3-clip&info=true');
    expect(info.body.cid).toBe(`${viaHls(S3_ZONE, 'hls/manifest.m3u8')}&s3=1`);
  });

  it('hot: the hotnode, flagged', async () => {
    await seedEmbed({ permlink: 's3-hot-clip', storage_state: 'hot', s3_url: S3_DIRECT });
    const res = await request(app).get('/api/embed?v=badadib/s3-hot-clip');
    expect(res.body.videoUrl).toBe(`${viaHls(MASTER)}&s3=1`);
  });

  it('strict=1: the S3 zone only, and a placeholder is never strict', async () => {
    await seedEmbed({ permlink: 's3-strict-clip', storage_state: 'archived', s3_url: S3_DIRECT });
    const web = await request(app).get('/api/embed?v=badadib/s3-strict-clip&strict=1');
    expect(web.body.strict).toBe(true);
    expect(web.body.videoUrl).toBe(`${viaHls(S3_ZONE)}&s3=1&strict=1`);
    await seedEmbed({ permlink: 's3-gone-strict', status: 'deleted', storage_state: 'archived', s3_url: S3_DIRECT });
    expect((await request(app).get('/api/embed?v=badadib/s3-gone-strict&strict=1')).body.strict).toBe(false);
  });

  it('a placeholder ignores storage_state', async () => {
    await seedEmbed({ permlink: 's3-gone', status: 'deleted', storage_state: 'archived', s3_url: S3_DIRECT });
    const res = await request(app).get('/api/embed?v=badadib/s3-gone');
    expect(res.body.videoUrl).toBe(viaHls('https://gw.test/ipfs/QmDeleted/manifest.m3u8'));
  });
});

describe('GET /api/embed: database failure', () => {
  it('500 with a generic error', async () => {
    const db = serverDb();
    await db.close();
    try {
      const res = await request(app).get('/api/embed?v=badadib/anything');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    } finally {
      await db.connect();
    }
  });
});

describe('GET /api/timeline', () => {
  it.each(['', 'badadib', 'Bad_Name/post', 'badadib/Not Valid', 'ab/post'])('400 for post=%s', async (post) => {
    const res = await request(app).get(`/api/timeline?post=${encodeURIComponent(post)}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid post. Expected: author/permlink' });
  });

  it('returns the sanitised timeline, cacheable', async () => {
    hivePosts['badadib/tl-post'] = {
      video: { chapters: [{ start: 12, title: '  Part\u0000 two ' }, { start: -1, title: 'bad' }, { start: 12, title: 'dupe' }] },
    };
    const res = await request(app).get('/api/timeline?post=badadib/tl-post');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toEqual({ timeline: { chapters: [{ start: 12, title: 'Part two' }], links: [] } });
  });

  it('null timeline for a post without one, still cacheable', async () => {
    hivePosts['badadib/plain-post'] = { app: '3speak/0.3' };
    const res = await request(app).get('/api/timeline?post=badadib/plain-post');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body).toEqual({ timeline: null });
  });

  it('null timeline and no-store when Hive fails, so a blip is not cached downstream', async () => {
    hivePosts['badadib/hive-down'] = () => json({}, 502);
    const res = await request(app).get('/api/timeline?post=badadib/hive-down');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ timeline: null });
  });

  it('shares one Hive request between concurrent callers', async () => {
    let release;
    hivePosts['badadib/busy-post'] = () => new Promise((r) => {
      release = () => r(hivePost('badadib', 'busy-post', { video: { chapters: [{ start: 1, title: 'One' }] } }));
    });
    const a = request(app).get('/api/timeline?post=badadib/busy-post').then((r) => r);
    const b = request(app).get('/api/timeline?post=badadib/busy-post').then((r) => r);
    await expect.poll(() => typeof release).toBe('function');
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body).toEqual(rb.body);
    expect(ra.body.timeline.chapters).toEqual([{ start: 1, title: 'One' }]);
    expect(hiveCalls()).toEqual(['badadib/busy-post']);
  });
});
