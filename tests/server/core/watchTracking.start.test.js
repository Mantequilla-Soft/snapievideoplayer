// POST /api/watch/start for videos: which plays open a measured session, and
// what that session records (and never records).
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../../helpers/mongo.js';
import { call } from './_helpers/http.js';
import {
  loadTracking, driver, seedVideo, freezeClock, rows, one, VIDEO, HEADERS, THROWING_IP, geoCalls,
} from './_helpers/tracking.js';

let wt;
let db;
let d;

beforeAll(async () => {
  ({ wt, db } = await loadTracking());
  d = driver(wt);
});
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  freezeClock();
  await resetDb();
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await db.close();
  await closeTestDb();
});

const sessions = () => rows('view-sessions');

describe('watchStart: which requests are refused', () => {
  it.each([
    [{ owner: '', permlink: 'abc123' }],
    [{ owner: 'badadib', permlink: '' }],
    [{ owner: 'bad adib', permlink: 'abc123' }],
    [{ owner: 'badadib', permlink: 'abc/123' }],
    [{ owner: 42, permlink: 'abc123' }],
  ])('answers 400 for an invalid owner/permlink %j', async (body) => {
    const r = await d.start(body);
    expect(r).toEqual({ status: 400, body: { error: 'Invalid owner/permlink' } });
  });

  it('answers 400 when there is no body at all', async () => {
    const r = await call(wt.watchStart, { headers: {} });
    expect(r.status).toBe(400);
  });

  it('answers 404 for a video that does not exist', async () => {
    const r = await d.start();
    expect(r).toEqual({ status: 404, body: { error: 'Video not found' } });
    expect(await sessions()).toEqual([]);
  });

  it.each(['deleted', 'encoding_ipfs', 'failed'])('does not track a placeholder (%s) video', async (status) => {
    await seedVideo({ status });
    expect((await d.start()).body).toEqual({ tracked: false, reason: 'placeholder' });
    expect(await sessions()).toEqual([]);
    expect(await rows('view-heatmaps')).toEqual([]);
  });

  it('does not track a video with no usable duration', async () => {
    await seedVideo({ duration: 0 });
    expect((await d.start()).body).toEqual({ tracked: false, reason: 'no_duration' });
    expect((await d.start({ duration: 'abc' })).body).toEqual({ tracked: false, reason: 'no_duration' });
    expect((await d.start({ duration: 90000 })).body).toEqual({ tracked: false, reason: 'no_duration' });
    expect(await sessions()).toEqual([]);
  });
});

describe('watchStart: opening a session', () => {
  it('answers with a session id, a token and the beat interval', async () => {
    await seedVideo();
    const r = await d.start();
    expect(r.status).toBe(200);
    expect(r.body.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.beatSeconds).toBe(5);
  });

  it('gives every play its own session id and token', async () => {
    await seedVideo();
    const a = (await d.start()).body;
    const b = (await d.start()).body;
    expect(a.sid).not.toBe(b.sid);
    expect(a.token).not.toBe(b.token);
    expect(await sessions()).toHaveLength(2);
  });

  it('stores the session state, starting from zero', async () => {
    await seedVideo();
    const { sid } = (await d.start({ source: '3speak' })).body;
    const s = await one('view-sessions', { sid });
    expect(s).toMatchObject({
      owner: 'badadib', permlink: 'abc123', type: 'embed', source: '3speak', viewer: null, incViewer: null,
      durationMs: 40000, heatmapDuration: 40, bucketCount: 100, country: 'US', premium: false, private: false,
      userAgent: 'vitest-agent', accumulatedMs: 0, contentMs: 0, visibleContentMs: 0,
      startPosition: 0, lastPosition: 0, maxPosition: 0, coveredBuckets: [], rateSum: 0, rateBeats: 0,
    });
    expect(s.startedAt.getTime()).toBe(Date.now());
    expect(s.lastBeatAt.getTime()).toBe(Date.now());
    // Lives a few video lengths plus five minutes.
    expect(s.expiresAt.getTime()).toBe(Date.now() + 40000 * 4 + 5 * 60 * 1000);
  });

  it('keys the session on the asset permlink when opened by the Hive permlink', async () => {
    await seedVideo();
    const { sid } = (await d.start({ permlink: VIDEO.hive_permlink })).body;
    expect((await one('view-sessions', { sid })).permlink).toBe('abc123');
    expect((await one('view-heatmaps')).permlink).toBe('abc123');
  });

  it('looks a legacy video up in the legacy collection', async () => {
    await seedVideo({ permlink: 'oldvid', hive_permlink: undefined }, process.env.MONGODB_COLLECTION_LEGACY);
    expect((await d.start({ permlink: 'oldvid' })).status).toBe(404);
    const r = await d.start({ permlink: 'oldvid', type: 'legacy' });
    expect(r.status).toBe(200);
    expect((await one('view-sessions', { sid: r.body.sid })).type).toBe('legacy');
  });

  it('treats any type other than legacy or live as embed', async () => {
    await seedVideo();
    const r = await d.start({ type: 'something' });
    expect((await one('view-sessions', { sid: r.body.sid })).type).toBe('embed');
  });

  it('trims owner and permlink', async () => {
    await seedVideo();
    const r = await d.start({ owner: ' badadib ', permlink: ' abc123 ' });
    expect(r.status).toBe(200);
  });

  it('records a premium (ad-free) playback only for premium === true', async () => {
    await seedVideo();
    const yes = (await d.start({ premium: true })).body.sid;
    const no = (await d.start({ premium: 'true' })).body.sid;
    expect((await one('view-sessions', { sid: yes })).premium).toBe(true);
    expect((await one('view-sessions', { sid: no })).premium).toBe(false);
  });
});

describe('watchStart: the duration used for % and the heatmap', () => {
  const durationFor = async (body, docDuration) => {
    await resetDb();
    await seedVideo({ duration: docDuration });
    const { sid } = (await d.start(body)).body;
    return (await one('view-sessions', { sid })).heatmapDuration;
  };

  it('prefers the player duration when it roughly agrees with the stored one', async () => {
    expect(await durationFor({ duration: 38.6 }, 40)).toBe(39);
    expect(await durationFor({ duration: 20 }, 40)).toBe(20); // exactly half is still trusted
  });

  it('uses the stored duration when the player reports less than half of it', async () => {
    expect(await durationFor({ duration: 6 }, 120)).toBe(120);
  });

  it('uses the player duration when the stored one is missing or absurd', async () => {
    expect(await durationFor({ duration: 75 }, undefined)).toBe(75);
    expect(await durationFor({ duration: 75 }, 90000)).toBe(75);
  });

  it('uses the stored duration when the player sends none', async () => {
    expect(await durationFor({}, 40)).toBe(40);
  });
});

describe('watchStart: the per-video heatmap document', () => {
  it('is created with zeroed buckets on the first play and counts sessions', async () => {
    await seedVideo();
    await d.start();
    const hm = await one('view-heatmaps');
    expect(hm).toMatchObject({ owner: 'badadib', permlink: 'abc123', type: 'embed', duration: 40, bucketCount: 100, sessions: 1 });
    expect(hm.buckets).toEqual(new Array(100).fill(0));
    await d.start();
    expect((await one('view-heatmaps')).sessions).toBe(2);
  });

  it('keeps the first duration as the axis every later session buckets against', async () => {
    await seedVideo();
    await d.start({ duration: 40 });
    const { sid } = (await d.start({ duration: 44 })).body;
    expect((await one('view-heatmaps')).duration).toBe(40);
    const s = await one('view-sessions', { sid });
    expect([s.durationMs, s.heatmapDuration]).toEqual([44000, 40]);
  });
});

describe('watchStart: start position', () => {
  it('records where the viewer opened the video', async () => {
    await seedVideo();
    const { sid } = (await d.start({ position: 12.5 })).body;
    expect(await one('view-sessions', { sid })).toMatchObject({ startPosition: 12.5, lastPosition: 12.5, maxPosition: 12.5 });
  });

  it('clamps a position past the end to the duration, and junk to 0', async () => {
    await seedVideo();
    const past = (await d.start({ position: 500 })).body.sid;
    const neg = (await d.start({ position: -3 })).body.sid;
    const junk = (await d.start({ position: 'x' })).body.sid;
    expect((await one('view-sessions', { sid: past })).startPosition).toBe(40);
    expect((await one('view-sessions', { sid: neg })).startPosition).toBe(0);
    expect((await one('view-sessions', { sid: junk })).startPosition).toBe(0);
  });
});

describe('watchStart: privacy', () => {
  const countryFor = async (headers, body = {}, extra = {}) => {
    const r = await call(wt.watchStart, {
      body: { owner: 'badadib', permlink: 'abc123', ...body }, headers, ...extra,
    });
    return (await one('view-sessions', { sid: r.body.sid })).country;
  };

  beforeEach(() => seedVideo());

  it('resolves the country from X-Real-IP, then X-Forwarded-For, then the socket', async () => {
    expect(await countryFor({ 'x-real-ip': ' 198.51.100.9 ' })).toBe('DE');
    expect(await countryFor({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })).toBe('US');
    expect(await countryFor({}, {}, { socket: { remoteAddress: '2001:db8::1' } })).toBe('FR');
    expect(await countryFor({}, {}, { ip: '198.51.100.9' })).toBe('DE');
  });

  it('records no country for an IP that cannot be placed or breaks the lookup', async () => {
    expect(await countryFor({ 'x-real-ip': '10.1.2.3' })).toBeNull();
    expect(await countryFor({ 'x-real-ip': THROWING_IP })).toBeNull();
    geoCalls.length = 0;
    expect(await countryFor({})).toBeNull(); // no address at all: 'unknown'
    expect(geoCalls).toEqual([]);
  });

  it('suppresses the country in private mode, true or "true"', async () => {
    geoCalls.length = 0;
    expect(await countryFor(HEADERS, { private: true })).toBeNull();
    expect(await countryFor(HEADERS, { private: 'true' })).toBeNull();
    expect(geoCalls).toEqual([]);
    const s = (await sessions()).map((x) => x.private);
    expect(s).toEqual([true, true]);
  });

  it('never writes the IP or an old client device id anywhere', async () => {
    await d.start({ viewerId: 'device-123' });
    const dump = JSON.stringify(await (await testDb()).collection('view-sessions').find().toArray());
    expect(dump).not.toContain('203.0.113.7');
    expect(dump).not.toContain('device-123');
    expect((await sessions())[0]).not.toHaveProperty('ip');
  });
});

describe('watchStart: source and identity', () => {
  beforeEach(() => seedVideo());
  const sessionFor = async (body) => one('view-sessions', { sid: (await d.start(body)).body.sid });

  it('labels where the view happened, defaulting to the embed player', async () => {
    expect((await sessionFor({})).source).toBe('player');
    expect((await sessionFor({ source: '3Speak!' })).source).toBe('3speak');
    expect((await sessionFor({ source: 'a'.repeat(30) })).source).toBe('a'.repeat(20));
    expect((await sessionFor({ source: '!!!' })).source).toBe('player');
  });

  it('keeps an unsigned viewer name only from 3speak.tv, lowercased', async () => {
    expect((await sessionFor({ source: '3speak', viewer: ' Viewer1 ' })).viewer).toBe('viewer1');
    expect((await sessionFor({ source: 'player', viewer: 'viewer1' })).viewer).toBeNull();
    expect((await sessionFor({ source: 'someapp', viewer: 'viewer1' })).viewer).toBeNull();
  });

  it('keeps a valid incubation handle and drops an invalid one', async () => {
    expect((await sessionFor({ incubationViewer: ' New.User-1 ' })).incViewer).toBe('new.user-1');
    expect((await sessionFor({ incubationViewer: 'ab' })).incViewer).toBeNull();
    expect((await sessionFor({ incubationViewer: 'bad handle!' })).incViewer).toBeNull();
  });
});
