// POST /api/view, POST /api/duration, POST /api/watch/start + /api/watch/beat and
// GET /api/heatmap, as wired in server.js. The tracker's own rules are covered by
// the watchTracking suites; here we check the HTTP contract end to end.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { resetDb, closeTestDb, testDb } from '../../helpers/mongo.js';
import { loadServer, stopServer, serverDb, TEST_ENV } from './_helpers/loadServer.js';
import { installFetch, json } from './_helpers/fakeFetch.js';
import { seedLegacy, seedEmbed, findEmbed, findLegacy } from './_helpers/fixtures.js';

let app;

beforeAll(async () => { app = await loadServer(); });
afterAll(async () => { await stopServer(); await closeTestDb(); });
beforeEach(async () => {
  await resetDb();
  installFetch();
});

const expectedIpHash = (ip, permlink) => crypto
  .createHmac('sha256', TEST_ENV.VIEW_IP_HASH_SECRET).update(`${ip}|${permlink}`).digest('hex').slice(0, 32);

async function withDatabaseDown(fn) {
  const db = serverDb();
  await db.close();
  try { return await fn(); } finally { await db.connect(); }
}

describe('POST /api/view', () => {
  it('400 when a field is missing', async () => {
    const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'p' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('a request without a JSON body answers 400, not a 500 crash', async () => {
    const res = await request(app).post('/api/view');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('400 for an unknown type', async () => {
    const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'p', type: 'shorts' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid type. Must be "legacy" or "embed"' });
  });

  it('404 when the video does not exist', async () => {
    const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'ghost', type: 'embed' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not found' });
  });

  it('legacy: increments views on the videos row', async () => {
    await seedLegacy({ permlink: 'lv', views: 7 });
    const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'lv', type: 'legacy' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, counted: true });
    expect((await findLegacy('badadib', 'lv')).views).toBe(8);
    expect(await (await testDb()).collection('views').countDocuments()).toBe(0);
  });

  it('embed: increments views and logs a per-video hashed IP row', async () => {
    await seedEmbed({ permlink: 'ev', views: undefined });
    const res = await request(app)
      .post('/api/view')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('User-Agent', 'test-agent/1.0')
      .send({ owner: 'badadib', permlink: 'ev', type: 'embed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, counted: true });
    expect((await findEmbed('badadib', 'ev')).views).toBe(1);
    const rows = await (await testDb()).collection('views').find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      author: 'badadib',
      permlink: 'ev',
      ipHash: expectedIpHash('203.0.113.9', 'ev'),
      userAgent: 'test-agent/1.0',
      __v: 0,
    });
    expect(rows[0].timestamp).toBeInstanceOf(Date);
    expect(rows[0]).not.toHaveProperty('userIP');
  });

  it('embed: counts a view requested by the Hive permlink', async () => {
    await seedEmbed({ permlink: 'asset-1', hive_permlink: 'post-1', views: 3 });
    const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'post-1', type: 'embed' });
    expect(res.body).toEqual({ success: true, counted: true });
    expect((await findEmbed('badadib', 'asset-1')).views).toBe(4);
  });

  it('accepts a form-encoded body too', async () => {
    await seedLegacy({ permlink: 'form-view', views: 0 });
    const res = await request(app).post('/api/view').type('form').send('owner=badadib&permlink=form-view&type=legacy');
    expect(res.body).toEqual({ success: true, counted: true });
  });

  it.each(['scheduled', 'publish_later', 'publish_manual'])('counts status %s', async (status) => {
    await seedLegacy({ permlink: 'sv', status, views: 0 });
    const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'sv', type: 'legacy' });
    expect(res.body.counted).toBe(true);
  });

  it.each(['deleted', 'encoding_ipfs', 'failed', undefined])('does not count a placeholder (status %s)', async (status) => {
    await seedEmbed({ permlink: 'pv', status, views: 5 });
    const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'pv', type: 'embed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, counted: false, reason: 'Video not in published state' });
    expect((await findEmbed('badadib', 'pv')).views).toBe(5);
    expect(await (await testDb()).collection('views').countDocuments()).toBe(0);
  });

  it('an expired story plays the expiry clip, so its view is not counted', async () => {
    await seedEmbed({ permlink: 'old-story', story: true, story_expires_at: new Date(Date.now() - 60e3), views: 5 });
    const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'old-story', type: 'embed' });
    expect(res.body.counted).toBe(false);
    expect((await findEmbed('badadib', 'old-story')).views).toBe(5);
  });

  it('still counts the view when the per-event log cannot be written', async () => {
    const db = await testDb();
    await db.collection('views').drop().catch(() => {});
    await db.createCollection('views', {
      validator: { $jsonSchema: { required: ['never_present'] } },
    });
    try {
      await seedEmbed({ permlink: 'log-fails', views: 1 });
      const res = await request(app).post('/api/view').send({ owner: 'badadib', permlink: 'log-fails', type: 'embed' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, counted: true });
      expect((await findEmbed('badadib', 'log-fails')).views).toBe(2);
    } finally {
      await db.collection('views').drop();
    }
  });

  it('500 when the database is down', async () => {
    const res = await withDatabaseDown(() =>
      request(app).post('/api/view').send({ owner: 'badadib', permlink: 'x', type: 'legacy' }));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('POST /api/duration', () => {
  it('stores a missing duration', async () => {
    await seedEmbed({ permlink: 'dur', duration: 0 });
    const res = await request(app).post('/api/duration').send({ owner: 'badadib', permlink: 'dur', duration: 93.6 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect((await findEmbed('badadib', 'dur')).duration).toBe(94);
  });

  it('finds the asset by its Hive permlink', async () => {
    await seedEmbed({ permlink: 'asset-d', hive_permlink: 'post-d', duration: 10 });
    const res = await request(app).post('/api/duration').send({ owner: 'badadib', permlink: 'post-d', duration: 45 });
    expect(res.body).toEqual({ success: true });
    expect((await findEmbed('badadib', 'asset-d')).duration).toBe(45);
  });

  it('refuses to shrink a plausible stored duration', async () => {
    await seedEmbed({ permlink: 'keep', duration: 600 });
    const res = await request(app).post('/api/duration').send({ owner: 'badadib', permlink: 'keep', duration: 6 });
    expect(res.body).toEqual({ success: false });
    expect((await findEmbed('badadib', 'keep')).duration).toBe(600);
  });

  it('success false for an unknown video', async () => {
    const res = await request(app).post('/api/duration').send({ owner: 'badadib', permlink: 'nope', duration: 6 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false });
  });

  it.each([
    ['owner missing', { permlink: 'p', duration: 5 }],
    ['owner with odd characters', { owner: 'bad adib', permlink: 'p', duration: 5 }],
    ['permlink blank', { owner: 'badadib', permlink: '  ', duration: 5 }],
    ['duration as a string', { owner: 'badadib', permlink: 'p', duration: '5' }],
    ['duration zero', { owner: 'badadib', permlink: 'p', duration: 0 }],
    ['duration negative', { owner: 'badadib', permlink: 'p', duration: -3 }],
  ])('400 for %s', async (_label, body) => {
    const res = await request(app).post('/api/duration').send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing or invalid fields' });
  });

  it('a request without a JSON body answers 400, not a 500 crash', async () => {
    const res = await request(app).post('/api/duration');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing or invalid fields' });
  });

  it('500 when the database is down', async () => {
    const res = await withDatabaseDown(() =>
      request(app).post('/api/duration').send({ owner: 'badadib', permlink: 'p', duration: 5 }));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});

describe('POST /api/watch/start', () => {
  it('opens a session for a playable video and seeds its heatmap', async () => {
    await seedEmbed({ permlink: 'w1', duration: 100 });
    const res = await request(app).post('/api/watch/start').send({ owner: 'badadib', permlink: 'w1', type: 'embed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sid: expect.stringMatching(/^[0-9a-f]{32}$/), token: expect.stringMatching(/^[0-9a-f]{64}$/), beatSeconds: 5 });
    const db = await testDb();
    const session = await db.collection('view-sessions').findOne({ sid: res.body.sid });
    expect(session).toMatchObject({ owner: 'badadib', permlink: 'w1', type: 'embed', heatmapDuration: 100 });
    const hm = await db.collection('view-heatmaps').findOne({ owner: 'badadib', permlink: 'w1' });
    expect(hm).toMatchObject({ sessions: 1, duration: 100, bucketCount: 100 });
  });

  it('400 for an invalid owner/permlink', async () => {
    const res = await request(app).post('/api/watch/start').send({ owner: 'bad adib', permlink: 'w1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid owner/permlink' });
  });

  it('400 without a body', async () => {
    const res = await request(app).post('/api/watch/start');
    expect(res.status).toBe(400);
  });

  it('404 for an unknown video', async () => {
    const res = await request(app).post('/api/watch/start').send({ owner: 'badadib', permlink: 'ghost', type: 'legacy' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Video not found' });
  });

  it('does not track a placeholder', async () => {
    await seedLegacy({ permlink: 'w-del', status: 'deleted' });
    const res = await request(app).post('/api/watch/start').send({ owner: 'badadib', permlink: 'w-del', type: 'legacy' });
    expect(res.body).toEqual({ tracked: false, reason: 'placeholder' });
  });

  it('does not track a live room that is not broadcasting', async () => {
    installFetch((url) => (url.startsWith('https://live.test/rooms/') ? json({ mode: 'standalone', host: 'badadib', broadcasting: false }) : undefined));
    const res = await request(app).post('/api/watch/start').send({ owner: 'badadib', permlink: 'room-1', type: 'live' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tracked: false, reason: 'not_live' });
  });
});

describe('POST /api/watch/beat', () => {
  async function start(permlink = 'b1') {
    await seedEmbed({ permlink, duration: 100 });
    const res = await request(app).post('/api/watch/start').send({ owner: 'badadib', permlink, type: 'embed' });
    return res.body;
  }

  it('records progress in view-durations and the heatmap', async () => {
    const { sid, token } = await start();
    const res = await request(app).post('/api/watch/beat').send({ sid, token, position: 4 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ contentSeconds: 4, videoDuration: 100, position: 4 });
    const db = await testDb();
    const row = await db.collection('view-durations').findOne({ sid });
    expect(row).toMatchObject({ owner: 'badadib', permlink: 'b1', contentSeconds: 4, lastPosition: 4 });
    expect(row).not.toHaveProperty('ip');
  });

  it('400 without sid or token', async () => {
    const res = await request(app).post('/api/watch/beat').send({ sid: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid beat' });
  });

  it('410 for an unknown session', async () => {
    const res = await request(app).post('/api/watch/beat').send({ sid: 'f'.repeat(32), token: 'x' });
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'no_session' });
  });

  it('403 for a forged token', async () => {
    const { sid } = await start();
    const res = await request(app).post('/api/watch/beat').send({ sid, token: '0'.repeat(64), position: 3 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'bad_token' });
  });
});

describe('GET /api/heatmap', () => {
  it('400 for a malformed v', async () => {
    const res = await request(app).get('/api/heatmap?v=nope');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid v=owner/permlink' });
  });

  it('tracked false before anyone watched', async () => {
    const res = await request(app).get('/api/heatmap?v=badadib/unwatched');
    expect(res.body).toEqual({ tracked: false, bucketCount: 100, buckets: [], normalized: [] });
  });

  it('returns the buckets a watch filled, resolved from the Hive permlink', async () => {
    await seedEmbed({ permlink: 'hm-asset', hive_permlink: 'hm-post', duration: 100 });
    const start = await request(app).post('/api/watch/start').send({ owner: 'badadib', permlink: 'hm-post' });
    await request(app).post('/api/watch/beat').send({ sid: start.body.sid, token: start.body.token, position: 2 });
    const res = await request(app).get('/api/heatmap?v=badadib/hm-post');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tracked: true, owner: 'badadib', permlink: 'hm-asset', duration: 100, bucketCount: 100, sessions: 1, max: 1 });
    expect(res.body.buckets.slice(0, 4)).toEqual([1, 1, 1, 0]);
    expect(res.body.normalized.slice(0, 4)).toEqual([1, 1, 1, 0]);
  });

  it('500 when the database is down', async () => {
    const res = await withDatabaseDown(() => request(app).get('/api/heatmap?v=badadib/x'));
    expect(res.status).toBe(500);
  });
});
