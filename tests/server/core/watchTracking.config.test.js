// watchTracking.js: settings read from the environment at load time, index
// setup, and how the handlers fail when the database is not there.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../../helpers/mongo.js';
import { call } from './_helpers/http.js';
import { requireFresh, require, rootPath } from './_helpers/load.js';
import {
  installFakeGeoip, loadTracking, driver, seedVideo, freezeClock, one, rows, optIn, mintToken,
  streamingServer, liveRoomDoc, PARTNER_SECRET, HEADERS,
} from './_helpers/tracking.js';

afterAll(async () => {
  await require(rootPath('db.js')).close();
  await closeTestDb();
});

describe('before the database is connected', () => {
  let wt;
  let db;
  let err;

  beforeAll(() => {
    installFakeGeoip();
    wt = requireFresh('watchTracking.js', {}, ['db.js']); // with its own, unconnected db module
    db = require(rootPath('db.js'));
  });
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('watchStart answers 500 and logs why', async () => {
    const r = await call(wt.watchStart, { body: { owner: 'badadib', permlink: 'abc123' }, headers: {} });
    expect(r).toEqual({ status: 500, body: { error: 'Internal server error' } });
    expect(err).toHaveBeenCalledWith('Failed to ensure watch-duration indexes:', 'Database not connected. Call connect() first.');
    expect(err).toHaveBeenCalledWith('Error starting watch session:', expect.any(Error));
  });

  it('watchBeat answers 500', async () => {
    const r = await call(wt.watchBeat, { body: { sid: 'a', token: 'b' } });
    expect(r).toEqual({ status: 500, body: { error: 'Internal server error' } });
    expect(err).toHaveBeenCalledWith('Error recording watch beat:', expect.any(Error));
  });

  it('getHeatmap answers 500', async () => {
    const r = await call(wt.getHeatmap, { query: { v: 'badadib/abc123' } });
    expect(r).toEqual({ status: 500, body: { error: 'Internal server error' } });
    expect(err).toHaveBeenCalledWith('Error fetching heatmap:', expect.any(Error));
  });

  it('retries the index setup once connected, and drops the old per-IP index', async () => {
    await db.connect();
    const database = await testDb();
    await database.collection('view-durations').createIndex({ ip: 1, updatedAt: -1 });
    await seedVideo();
    const r = await call(wt.watchStart, { body: { owner: 'badadib', permlink: 'abc123' }, headers: HEADERS });
    expect(r.status).toBe(200);

    const keys = async (name) => (await database.collection(name).indexes()).map((i) => [i.key, !!i.unique, i.expireAfterSeconds]);
    expect(await keys('view-durations')).toEqual(expect.arrayContaining([
      [{ sid: 1 }, true, undefined],
      [{ owner: 1, permlink: 1, updatedAt: -1 }, false, undefined],
      [{ owner: 1, country: 1 }, false, undefined],
    ]));
    expect((await database.collection('view-durations').indexes()).map((i) => i.name)).not.toContain('ip_1_updatedAt_-1');
    expect(await keys('view-sessions')).toEqual(expect.arrayContaining([[{ sid: 1 }, true, undefined], [{ expiresAt: 1 }, false, 0]]));
    expect(await keys('view-heatmaps')).toEqual(expect.arrayContaining([[{ owner: 1, permlink: 1 }, true, undefined]]));
    expect(await keys('incubation_watch')).toEqual(expect.arrayContaining([
      [{ handle: 1, owner: 1, permlink: 1 }, true, undefined],
      [{ handle: 1 }, false, undefined],
    ]));
  });

  it('sets the indexes up only once per process', async () => {
    const database = await testDb();
    await database.collection('view-heatmaps').dropIndex('owner_1_permlink_1');
    await call(wt.watchStart, { body: { owner: 'badadib', permlink: 'abc123' }, headers: HEADERS });
    const names = (await database.collection('view-heatmaps').indexes()).map((i) => i.name);
    expect(names).not.toContain('owner_1_permlink_1');
  });
});

describe('settings from the environment', () => {
  let wt;
  let d;

  beforeAll(async () => {
    ({ wt } = await loadTracking({
      WATCH_BEAT_SECONDS: '10',
      WATCH_BUCKET_COUNT: '20',
      AD_VIEWER_MIN_PCT: '50',
      AD_VIEWER_MAX_SECONDS: '12',
      INCUBATION_MAX_SECONDS: '9',
      WATCH_LOG_COLLECTION: 'vd',
      WATCH_SESSION_COLLECTION: 'vs',
      WATCH_HEATMAP_COLLECTION: 'vh',
      AD_VIEWER_PREFS_COLLECTION: 'prefs',
      AD_VIEWER_WATCH_COLLECTION: 'rewards',
      INCUBATION_WATCH_COLLECTION: 'inc',
      LIVE_ROOM_API_URLS: 'https://a.test/, ,https://b.test//',
      AD_STREAM_VIEWER_MIN_SECONDS: '10',
      AD_STREAM_VIEWER_MAX_SECONDS: '15',
      AD_VIEWER_TOKEN_REQUIRED: 'true',
      AD_VIEWER_TOKEN_MAX_TTL_S: '30',
      AD_PARTNER_KEYS: `partnerapp:${PARTNER_SECRET}`,
      AD_VIEWER_REWARD_SOURCES: '3speak,partnerapp',
    }));
    d = driver(wt);
  });
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    freezeClock();
    await resetDb();
    wt._liveRoomCache.clear();
    await seedVideo();
  });
  afterEach(() => { vi.useRealTimers(); });

  // Tokens must fit the 60s lifetime this module allows.
  const signed = (over = {}) => mintToken({ ttl: 60, ...over });

  it('uses the configured beat interval, bucket count and collections', async () => {
    const s = (await d.start()).body;
    expect(s.beatSeconds).toBe(10);
    expect((await one('vs', { sid: s.sid })).bucketCount).toBe(20);
    expect((await one('vh')).buckets).toHaveLength(20);
    await d.beat(s, { after: 10000, position: 10 });
    expect(await one('vd', { sid: s.sid })).toMatchObject({ watchedSeconds: 10, watchedPct: 30 });
    expect(await rows('view-sessions')).toEqual([]);
    expect(await rows('view-durations')).toEqual([]);
  });

  it('clamps one beat at 1.6 beat intervals', async () => {
    const s = (await d.start()).body;
    expect((await d.beat(s, { after: 10 * 60 * 1000, position: 1 })).body.watchedSeconds).toBe(16);
  });

  it('rewards at the configured % and caps at the configured seconds', async () => {
    await optIn('viewer1', true, 'prefs');
    const s = (await d.start({ source: 'partnerapp', viewerToken: signed() })).body;
    await d.play(s, 0, 15, { step: 5 });
    expect(await rows('rewards')).toEqual([]); // 40% so far
    await d.play(s, 15, 20, { step: 5 });
    expect(await rows('rewards')).toEqual([expect.objectContaining({ viewer: 'viewer1', watchedPct: 55, contentSeconds: 12, app: 'partnerapp' })]);
  });

  it('caps incubation watch time at INCUBATION_MAX_SECONDS', async () => {
    const s = (await d.start({ source: '3speak', incubationViewer: 'newbie1' })).body;
    await d.play(s, 0, 20, { step: 5 });
    expect((await one('inc')).contentSeconds).toBe(9);
  });

  it('with tokens required, drops an unsigned name even from 3speak.tv', async () => {
    const r = await d.start({ source: '3speak', viewer: 'viewer1' });
    expect((await one('vs', { sid: r.body.sid })).viewer).toBeNull();
    const ok = await d.start({ source: '3speak', viewerToken: signed() });
    expect((await one('vs', { sid: ok.body.sid })).viewer).toBe('viewer1');
  });

  it('never lets the maximum token lifetime drop below a minute', async () => {
    const at60 = await d.start({ viewerToken: signed({ ttl: 60 }) });
    const at61 = await d.start({ viewerToken: signed({ ttl: 61 }) });
    expect((await one('vs', { sid: at60.body.sid })).viewer).toBe('viewer1');
    expect((await one('vs', { sid: at61.body.sid })).viewer).toBeNull();
  });

  describe('several streaming servers', () => {
    const live = (over = {}) => d.start({ owner: 'host1', permlink: 'room-1', type: 'live', ...over });

    it('asks each in turn, trimmed, skipping one that does not have the room', async () => {
      const server = streamingServer();
      server.byBase = { 'https://a.test': null, 'https://b.test': liveRoomDoc() };
      expect((await live()).body.live).toBe(true);
      expect(server.calls).toEqual(['https://a.test/rooms/room-1', 'https://b.test/rooms/room-1']);
    });

    it('moves past a server that is down, and trusts the next one for a minute', async () => {
      const server = streamingServer();
      server.byBase = { 'https://a.test': 'error', 'https://b.test': liveRoomDoc() };
      expect((await live()).body.live).toBe(true);
      server.byBase = { 'https://a.test': null, 'https://b.test': null };
      vi.setSystemTime(Date.now() + 30 * 1000);
      expect((await live()).body.live).toBe(true);
      expect(server.calls).toHaveLength(2);
    });

    it('fails closed, and retries soon, when one server errors and the other lacks the room', async () => {
      const server = streamingServer();
      server.byBase = { 'https://a.test': 500, 'https://b.test': null };
      expect((await live()).body.reason).toBe('not_live');
      server.byBase = { 'https://a.test': liveRoomDoc(), 'https://b.test': null };
      vi.setSystemTime(Date.now() + 10 * 1000 + 1);
      expect((await live()).body.live).toBe(true);
    });

    it('banks a stream at the configured minimum, capped at the configured maximum', async () => {
      streamingServer();
      await optIn('viewer1', true, 'prefs');
      const s = (await live({ source: 'partnerapp', viewerToken: signed({ p: 'host1/room-1' }) })).body;
      let last;
      for (let t = 0; t < 20; t += 5) last = await d.beat(s);
      expect(last.body).toMatchObject({ liveSeconds: 20, qualifies: true });
      expect(await rows('rewards')).toEqual([expect.objectContaining({ viewer: 'viewer1', contentSeconds: 15, live: true, app: 'partnerapp' })]);
    });
  });
});

describe('settings below their floors', () => {
  let wt;
  let d;

  beforeAll(async () => {
    ({ wt } = await loadTracking({ WATCH_BUCKET_COUNT: '5', WATCH_BEAT_SECONDS: '-3', AD_VIEWER_MIN_PCT: 'abc' }));
    d = driver(wt);
  });
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    freezeClock();
    await resetDb();
    await seedVideo();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('never uses fewer than 10 buckets or a beat under a second', async () => {
    const s = (await d.start()).body;
    expect(s.beatSeconds).toBe(1);
    expect((await one('view-heatmaps')).buckets).toHaveLength(10);
  });

  it('never clamps a beat below 8 seconds', async () => {
    const s = (await d.start()).body;
    expect((await d.beat(s, { after: 60000, position: 1 })).body.watchedSeconds).toBe(8);
  });

  it('falls back to the 75% reward bar for an unreadable setting', async () => {
    await optIn('viewer1');
    const s = (await d.start({ source: '3speak', viewer: 'viewer1' })).body;
    await d.play(s, 0, 25);
    expect(await rows('ad_viewer_watch')).toEqual([]); // 70%
    await d.play(s, 25, 30);
    expect(await rows('ad_viewer_watch')).toHaveLength(1); // 80%
  });
});
