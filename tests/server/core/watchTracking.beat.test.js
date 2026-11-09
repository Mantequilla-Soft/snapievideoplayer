// POST /api/watch/beat for videos (watch time, contiguous-play windows, buckets,
// the durable view-durations row) and GET /api/heatmap.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../../helpers/mongo.js';
import { call } from './_helpers/http.js';
import { loadTracking, driver, seedVideo, freezeClock, one, rows } from './_helpers/tracking.js';

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
  await seedVideo(); // badadib/abc123, 40s: one bucket = 0.4s
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await db.close();
  await closeTestDb();
});

const open = async (body) => (await d.start(body)).body;
const heat = async () => (await one('view-heatmaps')).buckets;
const session = (sid) => one('view-sessions', { sid });
/** Bucket indexes with a count > 0, as [from, to] runs. */
const runs = (buckets) => {
  const out = [];
  buckets.forEach((x, i) => {
    if (!x) return;
    const last = out.at(-1);
    if (last && last[1] === i - 1 && last[2] === x) last[1] = i;
    else out.push([i, i, x]);
  });
  return out;
};

describe('watchBeat: which beats are refused', () => {
  it('answers 400 without a string sid and token', async () => {
    expect((await call(wt.watchBeat, { body: { sid: 'abc' } })).status).toBe(400);
    expect((await call(wt.watchBeat, { body: { sid: 1, token: 'x' } })).status).toBe(400);
    expect((await call(wt.watchBeat, {})).body).toEqual({ error: 'Invalid beat' });
  });

  it('answers 410 for a session that does not exist (or expired)', async () => {
    const r = await call(wt.watchBeat, { body: { sid: 'f'.repeat(32), token: 'a'.repeat(64) } });
    expect(r).toEqual({ status: 410, body: { error: 'no_session' } });
  });

  it('answers 403 for a token that belongs to another session or is malformed', async () => {
    const a = await open();
    const b = await open();
    expect(await d.beat({ sid: a.sid, token: b.token }, { position: 5 })).toEqual({ status: 403, body: { error: 'bad_token' } });
    expect((await d.beat({ sid: a.sid, token: 'short' }, { position: 5 })).status).toBe(403);
    expect((await session(a.sid)).accumulatedMs).toBe(0);
  });
});

describe('watchBeat: contiguous playback', () => {
  it('credits the measured gap and fills the buckets the playhead crossed', async () => {
    const s = await open();
    const r = await d.beat(s, { position: 5 });
    expect(r).toEqual({
      status: 200,
      body: { watchedSeconds: 5, contentSeconds: 5, watchedPct: 13, videoDuration: 40, position: 5 },
    });
    expect(runs(await heat())).toEqual([[0, 12, 1]]);
    const st = await session(s.sid);
    expect(st).toMatchObject({ accumulatedMs: 5000, contentMs: 5000, visibleContentMs: 5000, lastPosition: 5, maxPosition: 5 });
    expect(st.coveredBuckets.sort((x, y) => x - y)).toEqual(Array.from({ length: 13 }, (_, i) => i));
    expect(st.lastBeatAt.getTime()).toBe(Date.now());
  });

  it('adds up over beats and reaches 100% when the whole video is watched', async () => {
    const s = await open();
    const last = await d.play(s, 0, 40);
    expect(last.body).toEqual({ watchedSeconds: 40, contentSeconds: 40, watchedPct: 100, videoDuration: 40, position: 40 });
    // Bucket edges are shared by consecutive beats, so they count twice.
    const b = await heat();
    expect(b.every((x) => x >= 1)).toBe(true);
    expect(b[12]).toBe(2);
    expect(b[13]).toBe(1);
  });

  it('clamps a late beat, so idle time is never counted as watching', async () => {
    const s = await open();
    const r = await d.beat(s, { after: 10 * 60 * 1000, position: 5 });
    expect(r.body.watchedSeconds).toBe(8);
    expect(r.body.contentSeconds).toBe(5);
  });

  it('allows up to 2.5x the credited time of playhead advance, and at least 12s', async () => {
    const s = await open();
    expect((await d.beat(s, { after: 0, position: 12 })).body.contentSeconds).toBe(12);
    const t = await open();
    expect((await d.beat(t, { after: 0, position: 12.5 })).body.contentSeconds).toBe(0);
    const u = await open();
    expect((await d.beat(u, { after: 8000, position: 20 })).body.contentSeconds).toBe(20);
  });

  it('does not credit a clock that went backwards', async () => {
    const s = await open();
    const r = await d.beat(s, { after: -5000, position: 1 });
    expect(r.body.watchedSeconds).toBe(0);
    expect(r.body.contentSeconds).toBe(1);
  });

  it('clamps a position past the end of the video', async () => {
    const s = await open({ position: 38 });
    const r = await d.beat(s, { position: 99 });
    expect(r.body.position).toBe(40);
    expect(r.body.contentSeconds).toBe(2);
    expect((await heat())[99]).toBe(1);
  });

  it('counts hidden-tab beats for watch time and the heatmap all the same', async () => {
    const s = await open();
    const r = await d.beat(s, { position: 5, hidden: true });
    expect(r.body.contentSeconds).toBe(5);
    expect(runs(await heat())).toEqual([[0, 12, 1]]);
    expect((await session(s.sid)).visibleContentMs).toBe(0);
  });
});

describe('watchBeat: seeks are not watching', () => {
  it('credits the time but fills nothing on a jump forward', async () => {
    const s = await open();
    const r = await d.beat(s, { position: 30 });
    expect(r.body).toEqual({ watchedSeconds: 5, contentSeconds: 0, watchedPct: 0, videoDuration: 40, position: 30 });
    expect(runs(await heat())).toEqual([]);
    expect((await session(s.sid))).toMatchObject({ lastPosition: 30, maxPosition: 30 });
  });

  it('fills nothing on a rewind, then counts the replay as a second watch', async () => {
    const s = await open();
    await d.play(s, 0, 10);
    const before = (await d.beat(s, { position: 2 })).body; // rewind
    expect(before.watchedPct).toBe(26);
    const replay = await d.beat(s, { position: 6 });
    expect(replay.body.watchedPct).toBe(26); // nothing new seen
    expect(replay.body.contentSeconds).toBe(14);
    const b = await heat();
    expect(b[5]).toBe(2);
    expect(b[15]).toBe(2);
    expect(b[16]).toBe(1);
    expect((await session(s.sid)).maxPosition).toBe(10);
  });

  it('measures from where the viewer opened the video', async () => {
    const s = await open({ position: 20 });
    await d.beat(s, { position: 25 });
    expect(runs(await heat())).toEqual([[50, 62, 1]]);
  });
});

describe('watchBeat: playback speed', () => {
  it('averages the reported rates, ignoring junk', async () => {
    const s = await open();
    await d.beat(s, { position: 5, rate: 1.5 });
    await d.beat(s, { position: 10, rate: 'fast' });
    await d.beat(s, { position: 15, rate: -1 });
    await d.beat(s, { position: 20, rate: 2 });
    expect((await one('view-durations', { sid: s.sid })).avgRate).toBe(1.75);
    expect(await session(s.sid)).toMatchObject({ rateSum: 3.5, rateBeats: 2 });
  });

  it('records no average when no rate was ever reported', async () => {
    const s = await open();
    await d.beat(s, { position: 5 });
    expect((await one('view-durations', { sid: s.sid })).avgRate).toBeNull();
  });
});

describe('watchBeat: the view-durations row', () => {
  it('is one row per session, upserted on every beat', async () => {
    const s = await open({ position: 4, source: '3speak', premium: true });
    const startedAt = (await session(s.sid)).startedAt;
    await d.beat(s, { position: 9, rate: 1 });
    await d.beat(s, { position: 14, rate: 1 });
    const all = await rows('view-durations');
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      sid: s.sid, owner: 'badadib', permlink: 'abc123', type: 'embed', source: '3speak', country: 'US',
      premium: true, private: false, userAgent: 'vitest-agent', watchedSeconds: 10, contentSeconds: 10,
      videoDuration: 40, lastPosition: 14, maxPosition: 14, avgRate: 1, startPosition: 4,
    });
    expect(all[0].watchedPct).toBe(26);
    expect(all[0].startedAt.getTime()).toBe(startedAt.getTime());
    expect(all[0].updatedAt.getTime()).toBe(Date.now());
    expect(JSON.stringify(all[0])).not.toContain('203.0.113.7');
  });

  it('keeps private mode on the row, with no country', async () => {
    const s = await open({ private: true });
    await d.beat(s, { position: 5 });
    expect(await one('view-durations', { sid: s.sid })).toMatchObject({ private: true, country: null });
  });

  it('copes with older session rows that lack the newer fields', async () => {
    const s = await open();
    await (await testDb()).collection('view-sessions').updateOne(
      { sid: s.sid },
      { $unset: { heatmapDuration: 1, bucketCount: 1, lastPosition: 1, source: 1, country: 1, contentMs: 1, visibleContentMs: 1, coveredBuckets: 1, maxPosition: 1, rateSum: 1, rateBeats: 1, startPosition: 1 } },
    );
    const r = await d.beat(s, { position: 5 });
    expect(r.body).toEqual({ watchedSeconds: 5, contentSeconds: 5, watchedPct: 13, videoDuration: 40, position: 5 });
    expect(await one('view-durations', { sid: s.sid })).toMatchObject({ source: 'player', country: null, startPosition: 0 });
  });

  it('starts a separate row for every new play of the same video', async () => {
    await d.beat(await open(), { position: 5 });
    await d.beat(await open(), { position: 5 });
    expect(await rows('view-durations')).toHaveLength(2);
    expect(runs(await heat())).toEqual([[0, 12, 2]]);
    expect((await one('view-heatmaps')).sessions).toBe(2);
  });

  it('a seek-only beat still updates the row but leaves the heatmap untouched', async () => {
    const s = await open();
    const hmBefore = await one('view-heatmaps');
    await d.beat(s, { position: 35 });
    const hmAfter = await one('view-heatmaps');
    expect(hmAfter.updatedAt.getTime()).toBe(hmBefore.updatedAt.getTime());
    expect((await one('view-durations', { sid: s.sid })).lastPosition).toBe(35);
  });
});

describe('getHeatmap', () => {
  const get = (query) => call(wt.getHeatmap, { query });

  it.each([undefined, '', 'badadib', '/abc123', 'badadib/', 'bad adib/abc123', 'badadib/abc/123'])(
    'answers 400 for v=%j',
    async (v) => {
      const r = await get(v === undefined ? {} : { v });
      expect(r).toEqual({ status: 400, body: { error: 'Invalid v=owner/permlink' } });
    },
  );

  it('answers 400 without a query object', async () => {
    expect((await call(wt.getHeatmap, {})).status).toBe(400);
  });

  it('says untracked for a video nobody has played', async () => {
    expect((await get({ v: 'badadib/abc123' })).body).toEqual({ tracked: false, bucketCount: 100, buckets: [], normalized: [] });
    expect((await get({ v: 'viewer1/nothing' })).body.tracked).toBe(false);
  });

  it('returns the buckets, the peak and a 0..1 normalised copy', async () => {
    const a = await open();
    await d.beat(a, { position: 5 });
    const b = await open();
    await d.beat(b, { position: 2 });
    await d.beat(b, { position: 40, after: 0 }); // a seek: not filled
    const r = (await get({ v: 'badadib/abc123' })).body;
    expect(r).toMatchObject({ tracked: true, owner: 'badadib', permlink: 'abc123', duration: 40, bucketCount: 100, sessions: 2, max: 2 });
    expect(r.buckets.slice(0, 7)).toEqual([2, 2, 2, 2, 2, 2, 1]);
    expect(r.normalized.slice(0, 7)).toEqual([1, 1, 1, 1, 1, 1, 0.5]);
    expect(r.normalized[99]).toBe(0);
  });

  it('resolves the Hive permlink to the asset the beats keyed on', async () => {
    await d.beat(await open(), { position: 5 });
    expect((await get({ v: 'badadib/my-hive-post' })).body.permlink).toBe('abc123');
  });

  it('looks legacy videos up in the legacy collection', async () => {
    await seedVideo({ permlink: 'oldvid' }, process.env.MONGODB_COLLECTION_LEGACY);
    await d.beat(await open({ permlink: 'oldvid', type: 'legacy' }), { position: 5 });
    const r = (await get({ v: 'badadib/oldvid', type: 'legacy' })).body;
    expect(r).toMatchObject({ tracked: true, permlink: 'oldvid', max: 1 });
  });

  it('copes with a stored doc missing counts, or holding junk values', async () => {
    await (await testDb()).collection('view-heatmaps').insertOne({ owner: 'viewer1', permlink: 'vid1', buckets: ['3', null, 'x', 6] });
    const r = (await get({ v: 'viewer1/vid1' })).body;
    expect(r).toMatchObject({ tracked: true, bucketCount: 4, sessions: 0, max: 6, buckets: [3, 0, 0, 6], normalized: [0.5, 0, 0, 1] });
  });

  it('normalises an all-zero heatmap to zeros', async () => {
    await open();
    const r = (await get({ v: 'badadib/abc123' })).body;
    expect(r.max).toBe(0);
    expect(r.normalized).toEqual(new Array(100).fill(0));
  });

  it('rounds normalised values to three decimals', async () => {
    await (await testDb()).collection('view-heatmaps').insertOne({ owner: 'viewer1', permlink: 'vid2', bucketCount: 3, buckets: [1, 2, 3] });
    expect((await get({ v: 'viewer1/vid2' })).body.normalized).toEqual([0.333, 0.667, 1]);
  });
});
