// Live streams in the watch tracker: a session opens only on a stream that is
// really live, seconds are timed between beats while on screen, and a stream
// viewer reward banks at 5 minutes, one row per go-live.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { resetDb, closeTestDb, testDb } from '../../helpers/mongo.js';
import { call } from './_helpers/http.js';
import {
  loadTracking, freezeClock, tick, one, rows, optIn, streamingServer, liveRoomDoc, LIVE_AT, HEADERS,
} from './_helpers/tracking.js';

let wt;
let db;
let server;

beforeAll(async () => {
  ({ wt, db } = await loadTracking());
});
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  freezeClock();
  await resetDb();
  wt._liveRoomCache.clear();
  server = streamingServer(liveRoomDoc());
  await optIn('viewer1');
  await optIn('host1');
});
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  await db.close();
  await closeTestDb();
});

const NEXT_LIVE_AT = '2026-11-09T20:00:00.000Z';
const streamRow = (liveAt = LIVE_AT) => `room-1#live-${Date.parse(liveAt)}`;
const rewardRows = () => rows('ad_viewer_watch');

const start = (over = {}, headers = HEADERS) => call(wt.watchStart, {
  body: { owner: 'host1', permlink: 'room-1', type: 'live', source: '3speak', viewer: 'viewer1', ...over },
  headers,
});
const beat = (s, { after = 5000, headers = HEADERS, ...body } = {}) => {
  tick(after);
  return call(wt.watchBeat, { body: { sid: s.sid, token: s.token, ...body }, headers });
};
/** Open a session and beat every 5s for `seconds`. */
async function watchFor(seconds, over = {}, beatBody = {}) {
  const s = (await start(over)).body;
  let last;
  for (let t = 0; t < seconds; t += 5) last = await beat(s, beatBody);
  return { s, last };
}

describe('live watchStart', () => {
  it('opens a session on a broadcasting stream, keyed to this go-live', async () => {
    const r = await start();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ live: true, beatSeconds: 5 });
    expect(r.body.sid).toMatch(/^[0-9a-f]{32}$/);
    const s = await one('view-sessions', { sid: r.body.sid });
    expect(s).toMatchObject({
      owner: 'host1', permlink: 'room-1', type: 'live', streamAt: LIVE_AT, source: '3speak', viewer: 'viewer1', private: false, liveMs: 0,
    });
    expect(s.expiresAt.getTime()).toBe(Date.now() + 10 * 60 * 1000);
    expect(server.calls).toEqual(['https://live.3speak.tv/rooms/room-1']);
  });

  it('writes nothing a video session would (no heatmap, no view-durations)', async () => {
    const { s } = await watchFor(10);
    expect(s.live).toBe(true);
    expect(await rows('view-heatmaps')).toEqual([]);
    expect(await rows('view-durations')).toEqual([]);
  });

  it('matches the host without regard to case', async () => {
    server.room = liveRoomDoc({ host: 'HOST1' });
    const r = await start({ owner: 'Host1' });
    expect((await one('view-sessions', { sid: r.body.sid })).owner).toBe('host1');
  });

  it('still refuses an invalid host or room before asking the streaming server', async () => {
    expect((await start({ permlink: 'room 1' })).status).toBe(400);
    expect(server.calls).toEqual([]);
  });

  it.each([
    ['a room that does not exist', null],
    ['a conference room', liveRoomDoc({ mode: 'conference' })],
    ['a room hosted by somebody else', liveRoomDoc({ host: 'viewer9' })],
    ['a stream in standby', liveRoomDoc({ broadcasting: false })],
    ['a stream that never went live', liveRoomDoc({ liveAt: undefined })],
    ['a stream with an empty liveAt', liveRoomDoc({ liveAt: '' })],
    ['a server answering 500 (fails closed)', 500],
    ['a server that is down (fails closed)', 'error'],
  ])('%s: not_live, nothing opened', async (_label, answer) => {
    server.room = answer;
    expect((await start()).body).toEqual({ tracked: false, reason: 'not_live' });
    expect(await rows('view-sessions')).toEqual([]);
  });

  it('keeps an unsigned viewer name only from 3speak.tv', async () => {
    const r = await start({ source: 'player' });
    expect(await one('view-sessions', { sid: r.body.sid })).toMatchObject({ viewer: null, source: 'player' });
  });
});

describe('live watchBeat: what is counted', () => {
  it('credits the real time between beats', async () => {
    const s = (await start()).body;
    expect((await beat(s)).body).toEqual({ live: true, liveSeconds: 5, counting: true, qualifies: false });
    expect((await beat(s)).body.liveSeconds).toBe(10);
    const row = await one('view-sessions', { sid: s.sid });
    expect(row.liveMs).toBe(10000);
    expect(row.expiresAt.getTime()).toBe(Date.now() + 10 * 60 * 1000); // pushed on by each beat
  });

  it('clamps a late beat', async () => {
    const s = (await start()).body;
    expect((await beat(s, { after: 10 * 60 * 1000 })).body.liveSeconds).toBe(8);
  });

  it('counts nothing for a background tab, without asking the streaming server', async () => {
    const s = (await start()).body;
    server.calls.length = 0;
    const r = await beat(s, { hidden: 'true' });
    expect(r.body).toEqual({ live: true, liveSeconds: 0, counting: false, qualifies: false });
    expect(server.calls).toEqual([]);
  });

  it('stops counting once the stream has ended', async () => {
    const s = (await start()).body;
    await beat(s);
    server.room = null;
    wt._liveRoomCache.clear();
    expect((await beat(s)).body).toEqual({ live: true, liveSeconds: 5, counting: false, qualifies: false });
  });

  it('a stream that ended keeps counting until the cached answer is a minute old', async () => {
    const s = (await start()).body;
    server.room = null;
    expect((await beat(s, { after: 8000 })).body.counting).toBe(true);
    tick(52001);
    expect((await beat(s, { after: 0 })).body.counting).toBe(false);
  });

  it('does not count a new go-live under the same room name for an old session', async () => {
    const s = (await start()).body;
    server.room = liveRoomDoc({ liveAt: NEXT_LIVE_AT });
    wt._liveRoomCache.clear();
    expect((await beat(s)).body).toMatchObject({ liveSeconds: 0, counting: false });
  });

  it('answers 403 for a token from another live session', async () => {
    const a = (await start()).body;
    const b = (await start()).body;
    expect((await beat({ sid: a.sid, token: b.token })).status).toBe(403);
  });
});

describe('stream viewer reward', () => {
  it('banks one row at 5 minutes on screen, labelled live', async () => {
    const { last } = await watchFor(300);
    expect(last.body).toMatchObject({ liveSeconds: 300, qualifies: true });
    const [row, ...more] = await rewardRows();
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      viewer: 'viewer1', owner: 'host1', permlink: streamRow(), live: true, room: 'room-1',
      contentSeconds: 300, payoutId: null, app: '3speak',
    });
    expect(row.streamAt.toISOString()).toBe(LIVE_AT);
    expect(row).not.toHaveProperty('viewer_ip_hash');
  });

  it('banks nothing under 5 minutes', async () => {
    const { last } = await watchFor(295);
    expect(last.body.qualifies).toBe(false);
    expect(await rewardRows()).toEqual([]);
  });

  it('does not stack two tabs on the same stream', async () => {
    await watchFor(320);
    await watchFor(300);
    const all = await rewardRows();
    expect(all).toHaveLength(1);
    expect(all[0].contentSeconds).toBe(320);
  });

  it('keeps two go-lives of one room apart', async () => {
    await watchFor(300);
    server.room = liveRoomDoc({ liveAt: NEXT_LIVE_AT });
    wt._liveRoomCache.clear();
    await watchFor(300);
    expect((await rewardRows()).map((r) => r.permlink)).toEqual([streamRow(), streamRow(NEXT_LIVE_AT)]);
  });

  it('stores connection hashes when IP_HASH_SECRET is set', async () => {
    vi.stubEnv('IP_HASH_SECRET', 'hash-secret');
    await watchFor(300);
    const expected = crypto.createHmac('sha256', 'hash-secret').update('ip:203.0.113.7').digest('hex').slice(0, 32);
    expect((await rewardRows())[0].viewer_ip_hash).toBe(expected);
  });

  it.each([
    ['a viewer who has not opted in', { viewer: 'viewer2' }],
    ['the host watching their own stream', { viewer: 'Host1' }],
    ['private mode', { private: true }],
    ['an embed naming a viewer', { source: 'player' }],
    ['an anonymous viewer', { viewer: undefined }],
  ])('never banks for %s', async (_label, over) => {
    await watchFor(300, over);
    expect(await rewardRows()).toEqual([]);
  });

  it('never banks for a background tab', async () => {
    await watchFor(400, {}, { hidden: true });
    expect(await rewardRows()).toEqual([]);
  });

  it('banks nothing for a stream whose go-live time cannot be read', async () => {
    server.room = liveRoomDoc({ liveAt: 'not-a-date' });
    const { last } = await watchFor(300);
    expect(last.body.qualifies).toBe(true);
    expect(await rewardRows()).toEqual([]);
  });

  it('a failed write is logged and the beat still succeeds', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const database = await testDb();
    await database.createCollection('ad_viewer_watch').catch(() => {});
    await database.command({ collMod: 'ad_viewer_watch', validator: { contentSeconds: { $type: 'string' } } });
    try {
      const { last } = await watchFor(300);
      expect(last.status).toBe(200);
    } finally {
      await database.command({ collMod: 'ad_viewer_watch', validator: {} });
    }
    expect(err).toHaveBeenCalledWith('[stream-viewer-reward] not recorded:', expect.any(String));
  });
});

describe('room lookups are cached', () => {
  it('trusts an answer for a minute, then asks again', async () => {
    await start();
    await start();
    expect(server.calls).toHaveLength(1);
    tick(60 * 1000 + 1);
    await start();
    expect(server.calls).toHaveLength(2);
  });

  it('trusts a "not found" for a minute too', async () => {
    server.room = null;
    await start();
    server.room = liveRoomDoc();
    expect((await start()).body.reason).toBe('not_live');
    tick(60 * 1000 + 1);
    expect((await start()).body.live).toBe(true);
  });

  it('retries a failed lookup after ten seconds', async () => {
    server.room = 'error';
    await start();
    server.room = liveRoomDoc();
    expect((await start()).body.reason).toBe('not_live');
    tick(10 * 1000 + 1);
    expect((await start()).body.live).toBe(true);
  });

  it('caches per host and room', async () => {
    await start();
    await start({ permlink: 'room-2' });
    expect(server.calls).toEqual(['https://live.3speak.tv/rooms/room-1', 'https://live.3speak.tv/rooms/room-2']);
  });

  it('prunes expired answers once it holds more than 5000', async () => {
    const past = Date.now() - 1;
    for (let i = 0; i <= 5000; i++) wt._liveRoomCache.set(`old/${i}`, { value: null, exp: past });
    wt._liveRoomCache.set('keep/me', { value: null, exp: Date.now() + 60000 });
    await start();
    expect([...wt._liveRoomCache.keys()].sort()).toEqual(['host1/room-1', 'keep/me']);
  });
});
