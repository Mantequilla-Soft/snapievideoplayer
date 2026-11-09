/**
 * 🔴 Live streams in the watch tracker (watchTracking.js liveWatchStart /
 * liveWatchBeat / recordStreamViewerReward): who earns from the viewer pool as a
 * STREAM VIEWER, and when.
 *
 * Rules under test (owner, 2026-11-09): seconds are timed by the server between
 * beats, only while the tab is on screen and the room is really live; a watch
 * qualifies at 5 minutes and is capped at 20 per stream; one row per stream.
 *
 * 🚨 STUBBED database and streaming server: an in-memory stand-in for ./db and a
 * fake fetch for GET /rooms/:name. Nothing here touches Mongo or live.3speak.tv.
 *
 * Usage: node scripts/test-live-watch.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ─── an in-memory stand-in for the few Mongo calls the tracker makes ─── */
const data = {};
const matches = (doc, q) => Object.entries(q).every(([k, v]) => doc[k] === v);
function col(name) {
  data[name] = data[name] || [];
  const rows = data[name];
  return {
    createIndex: async () => {},
    dropIndex: async () => {},
    insertOne: async (d) => { rows.push({ ...d }); },
    findOne: async (q) => rows.find((d) => matches(d, q)) || null,
    updateOne: async (q, u, opts = {}) => {
      let d = rows.find((x) => matches(x, q));
      if (!d) {
        if (!opts.upsert) return;
        d = { ...q, ...(u.$setOnInsert || {}) };
        rows.push(d);
      }
      Object.assign(d, u.$set || {});
      for (const [k, v] of Object.entries(u.$max || {})) d[k] = d[k] === undefined ? v : Math.max(d[k], v);
    },
  };
}
require.cache[path.join(root, 'db.js')] = {
  id: path.join(root, 'db.js'), filename: path.join(root, 'db.js'), loaded: true,
  exports: { getDb: () => ({ collection: col }) },
};

const { watchStart, watchBeat, _liveRoomCache } = require(path.join(root, 'watchTracking.js'));

/* ─── the streaming server ─── */
const LIVE_AT = '2026-11-09T18:00:00.000Z';
let room = null;            // what GET /rooms/:name answers; null = 404; 'error' = down
global.fetch = async (url) => {
  if (!String(url).includes('/rooms/')) throw new Error(`unexpected fetch ${url}`);
  if (room === 'error') throw new Error('connect ECONNREFUSED');
  if (!room) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => room };
};
const liveRoom = (over = {}) => ({ name: 'room-1', mode: 'standalone', host: 'host1', broadcasting: true, liveAt: LIVE_AT, ...over });

/* ─── express stand-ins ─── */
function call(handler, body) {
  return new Promise((resolve, reject) => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this; },
      json(b) { resolve({ code: this.code, body: b }); return this; },
    };
    handler({ body, headers: { 'x-real-ip': '203.0.113.7' }, socket: {} }, res).catch(reject);
  });
}
const sessions = () => data['view-sessions'] || [];
const watchRows = () => data.ad_viewer_watch || [];
function reset() {
  for (const k of Object.keys(data)) delete data[k];
  _liveRoomCache.clear();
  room = liveRoom();
  col('ad_viewer_prefs').insertOne({ _id: 'alice', rewardsEnabled: true });
  col('ad_viewer_prefs').insertOne({ _id: 'host1', rewardsEnabled: true });
}
const start = (over = {}) => call(watchStart, { owner: 'host1', permlink: 'room-1', type: 'live', source: '3speak', viewer: 'alice', ...over });
/** One beat, `gapMs` after the previous one. */
async function beat(sid, token, gapMs = 5000, extra = {}) {
  const s = sessions().find((x) => x.sid === sid);
  s.lastBeatAt = new Date(Date.now() - gapMs);
  return call(watchBeat, { sid, token, ...extra });
}
async function watchFor(seconds, over = {}, beatExtra = {}) {
  const { body } = await start(over);
  let last;
  for (let t = 0; t < seconds; t += 5) last = await beat(body.sid, body.token, 5000, beatExtra);
  return { start: body, last };
}

/* ─── harness ─── */
let passed = 0; let failed = 0;
async function test(name, fn) {
  reset();
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
const quiet = console.error; console.error = () => {};

console.log('live sessions open only on a stream that is really live');
await test('a broadcasting stream by that host opens a session keyed to this go-live', async () => {
  const { body } = await start();
  eq([typeof body.sid, body.live, body.beatSeconds > 0], ['string', true, true], 'answer');
  eq(sessions()[0].streamAt, LIVE_AT, 'streamAt');
  eq(sessions()[0].type, 'live', 'type');
});
for (const [label, answer] of [
  ['a room that does not exist', null],
  ['a conference room', liveRoom({ mode: 'conference' })],
  ['a room hosted by somebody else', liveRoom({ host: 'mallory' })],
  ['a stream in standby (not broadcasting)', liveRoom({ broadcasting: false })],
  ['a stream that never went live', liveRoom({ liveAt: undefined })],
  ['a streaming server that is down (fails closed)', 'error'],
]) {
  await test(`${label}: not_live, nothing opened`, async () => {
    room = answer;
    eq((await start()).body, { tracked: false, reason: 'not_live' }, 'answer');
    eq(sessions().length, 0, 'sessions');
  });
}

console.log('what counts toward a stream-viewer reward');
await test('5 minutes on screen qualifies: one row, labelled live, seconds as watched', async () => {
  const { last } = await watchFor(300);
  eq([last.body.liveSeconds, last.body.qualifies], [300, true], 'beat answer');
  eq(watchRows().length, 1, 'rows');
  const r = watchRows()[0];
  eq([r.viewer, r.owner, r.permlink, r.live, r.room, r.contentSeconds, r.payoutId, r.app],
    ['alice', 'host1', `room-1#live-${Date.parse(LIVE_AT)}`, true, 'room-1', 300, null, '3speak'], 'row');
  eq(r.streamAt.toISOString(), LIVE_AT, 'streamAt');
});
await test('under 5 minutes banks nothing', async () => {
  await watchFor(295);
  eq(watchRows().length, 0, 'rows');
});
await test('capped at 20 minutes per stream', async () => {
  await watchFor(1500);
  eq(watchRows()[0].contentSeconds, 1200, 'seconds');
});
await test('a background tab earns nothing', async () => {
  const { last } = await watchFor(600, {}, { hidden: true });
  eq([last.body.liveSeconds, last.body.counting], [0, false], 'beat answer');
  eq(watchRows().length, 0, 'rows');
});
await test('a late beat is clamped, so a long gap is not counted as watching', async () => {
  const { body } = await start();
  const r = await beat(body.sid, body.token, 10 * 60 * 1000);
  if (!(r.body.liveSeconds > 0 && r.body.liveSeconds <= 8)) throw new Error(`credited ${r.body.liveSeconds}s for one beat`);
});
await test('two tabs on the same stream do not stack ($max, one row)', async () => {
  await watchFor(400);
  await watchFor(400);
  eq([watchRows().length, watchRows()[0].contentSeconds], [1, 400], 'row');
});
await test('the stream ended mid-watch: beats after it credit nothing', async () => {
  const { body } = await start();
  for (let t = 0; t < 200; t += 5) await beat(body.sid, body.token);
  room = null;
  _liveRoomCache.clear();
  let last;
  for (let t = 0; t < 200; t += 5) last = await beat(body.sid, body.token);
  eq([last.body.liveSeconds, last.body.counting], [200, false], 'beat answer');
  eq(watchRows().length, 0, 'rows');
});
await test('the room went live AGAIN under the same name: an old session does not count the new stream', async () => {
  const { body } = await start();
  room = liveRoom({ liveAt: '2026-11-09T20:00:00.000Z' });
  _liveRoomCache.clear();
  let last;
  for (let t = 0; t < 400; t += 5) last = await beat(body.sid, body.token);
  eq(last.body.liveSeconds, 0, 'seconds');
});
await test('the same room streamed twice: two streams, two rows', async () => {
  await watchFor(300);
  room = liveRoom({ liveAt: '2026-11-09T20:00:00.000Z' });
  _liveRoomCache.clear();
  await watchFor(300);
  eq(watchRows().map((r) => r.permlink), [`room-1#live-${Date.parse(LIVE_AT)}`, `room-1#live-${Date.parse('2026-11-09T20:00:00.000Z')}`], 'rows');
});

console.log('who never earns');
await test('a viewer who has not opted in', async () => {
  await watchFor(400, { viewer: 'bob' });
  eq(watchRows().length, 0, 'rows');
});
await test('the host watching their own stream', async () => {
  await watchFor(400, { viewer: 'host1' });
  eq(watchRows().length, 0, 'rows');
});
await test('private mode', async () => {
  await watchFor(400, { private: true });
  eq(watchRows().length, 0, 'rows');
});
await test('an unsigned name from anywhere but 3speak.tv (an embed) is dropped to anonymous', async () => {
  await watchFor(400, { source: 'player' });
  eq(watchRows().length, 0, 'rows');
});
await test('a beat with the wrong token is refused', async () => {
  const { body } = await start();
  eq((await beat(body.sid, 'x'.repeat(64))).code, 403, 'status');
});

console.log('the streaming server is asked once a minute per room, not on every beat');
await test('many beats from many viewers share one lookup', async () => {
  let asks = 0;
  const real = global.fetch;
  global.fetch = async (u) => { asks += 1; return real(u); };
  await watchFor(100);
  await watchFor(100, { viewer: 'carol' });
  global.fetch = real;
  eq(asks, 1, 'lookups');
});

console.error = quiet;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
