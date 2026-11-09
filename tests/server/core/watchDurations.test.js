// watch-durations.cjs, the operator's inspection script. It runs main() as soon
// as it is required, so each case loads it fresh with process.argv set and
// waits for it to close its Mongo client (or call process.exit).
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { resetDb, closeTestDb, testDb } from '../../helpers/mongo.js';
import { require, requireFresh, stubPackage, rootPath } from './_helpers/load.js';

// The script's MongoClient, wrapped so a test can tell when a run has finished.
const realMongo = require('mongodb');
const clients = [];
class TrackedClient extends realMongo.MongoClient {
  constructor(...args) {
    super(...args);
    this.isClosed = false;
    clients.push(this);
  }

  async close(...args) {
    const r = await super.close(...args);
    this.isClosed = true;
    return r;
  }
}
stubPackage('mongodb', { ...realMongo, MongoClient: TrackedClient });

afterAll(async () => {
  await Promise.all(clients.filter((c) => !c.isClosed).map((c) => c.close()));
  await closeTestDb();
});
beforeEach(resetDb);

/** Run the script with `args`; resolves to its console output. */
async function run(args, { env = {}, until } = {}) {
  const out = [];
  const errors = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
  const before = clients.length;
  const argv = process.argv;
  process.argv = ['node', rootPath('watch-durations.cjs'), ...args];
  try {
    requireFresh('watch-durations.cjs', env);
  } finally {
    process.argv = argv;
  }
  const client = () => clients[before];
  await vi.waitFor(() => {
    const done = until ? until(out) : (client()?.isClosed || exit.mock.calls.length > 0);
    if (!done) throw new Error('script still running');
  }, { timeout: 5000, interval: 5 });
  return { out, text: out.join('\n'), lines: out.join('\n').split('\n'), errors, exit, client: client() };
}

const at = (hhmmss) => new Date(`2026-11-09T${hhmmss}.000Z`);
async function seedRows() {
  const db = await testDb();
  await db.collection('view-durations').insertMany([
    { sid: 'sid-one', owner: 'badadib', permlink: 'abc123', type: 'embed', watchedSeconds: 30, videoDuration: 40, watchedPct: 76, startPosition: 0, lastPosition: 30.4, updatedAt: at('10:00:00') },
    { sid: 'sid-two', owner: 'badadib', permlink: 'other', type: 'legacy', watchedSeconds: 5, videoDuration: 100, watchedPct: 5, startPosition: 12, lastPosition: 17, updatedAt: at('10:05:00') },
    { sid: 'sid-three', owner: 'viewer1', permlink: 'vid', type: 'embed', ip: '5.6.7.8', watchedSeconds: 1, updatedAt: at('10:10:00') },
  ]);
}

describe('listing view-durations rows', () => {
  it('prints a count, a header and the rows, newest at the bottom', async () => {
    await seedRows();
    const { lines, client } = await run([]);
    expect(lines[1]).toBe('view-durations: 3 row(s) match · 0 live session(s) in view-sessions');
    const header = lines.find((l) => l.startsWith('updated'));
    expect(header).toMatch(/^updated\s+owner\/permlink\s+type\s+ip\s+watch\(s\)\s+dur\(s\)\s+pct\s+start\s+pos\s+sid/);
    const body = lines.filter((l) => /^\d\d:\d\d:\d\d/.test(l));
    expect(body.map((l) => l.slice(0, 8))).toEqual(['10:00:00', '10:05:00', '10:10:00']);
    expect(body[0]).toMatch(/badadib\/abc123\s+embed\s+30\s+40\s+76%\s+0s\s+30s\s+sid-one/);
    expect(body[2]).toMatch(/viewer1\/vid\s+embed\s+5\.6\.7\.8\s+1\s+sid-three/);
    expect(client.isClosed).toBe(true);
  });

  it('-n limits to the newest rows, while the count stays the total', async () => {
    await seedRows();
    const { lines } = await run(['-n', '2']);
    expect(lines[1]).toMatch(/^view-durations: 3 row\(s\) match/);
    expect(lines.filter((l) => /^\d\d:/.test(l)).map((l) => l.slice(0, 8))).toEqual(['10:05:00', '10:10:00']);
  });

  it('--video filters by owner/permlink, or by owner alone', async () => {
    await seedRows();
    expect((await run(['--video', 'badadib/abc123'])).lines[1]).toMatch(/^view-durations: 1 row\(s\)/);
    expect((await run(['--video', 'badadib'])).lines[1]).toMatch(/^view-durations: 2 row\(s\)/);
  });

  it('--ip filters on the legacy ip column', async () => {
    await seedRows();
    const { lines } = await run(['--ip', '5.6.7.8']);
    expect(lines[1]).toMatch(/^view-durations: 1 row\(s\)/);
  });

  it('--recent keeps only rows touched in the last N minutes', async () => {
    const db = await testDb();
    await db.collection('view-durations').insertMany([
      { sid: 'fresh', owner: 'badadib', permlink: 'a', updatedAt: new Date(Date.now() - 5 * 60 * 1000) },
      { sid: 'stale', owner: 'badadib', permlink: 'b', updatedAt: new Date(Date.now() - 20 * 60 * 1000) },
    ]);
    const { lines } = await run(['--recent', '10']);
    expect(lines[1]).toMatch(/^view-durations: 1 row\(s\)/);
    expect(lines.some((l) => l.includes('fresh'))).toBe(true);
    expect(lines.some((l) => l.includes('stale'))).toBe(false);
  });

  it('prints blanks for missing fields', async () => {
    await (await testDb()).collection('view-durations').insertOne({ sid: 'bare' });
    const { lines } = await run([]);
    const row = lines.find((l) => l.includes('bare'));
    expect(row.startsWith('--:--:--  undefined/undefined')).toBe(true);
    expect(row).not.toContain('%');
  });

  it('--sessions also lists live sessions with their accumulated time', async () => {
    const db = await testDb();
    await db.collection('view-sessions').insertMany([
      { sid: 'x1', owner: 'badadib', permlink: 'abc123', accumulatedMs: 12400, durationMs: 40000, lastBeatAt: at('11:00:00') },
      { sid: 'x2', owner: 'viewer1', permlink: 'vid' },
    ]);
    const { lines } = await run(['--sessions']);
    expect(lines[1]).toBe('view-durations: 0 row(s) match · 2 live session(s) in view-sessions');
    const i = lines.findIndex((l) => l.startsWith('live sessions (view-sessions)'));
    expect(i).toBeGreaterThan(0);
    expect(lines[i + 1]).toMatch(/^ {2}11:00:00 {2}badadib\/abc123\s+12s \/ 40s$/);
    expect(lines[i + 2]).toMatch(/^ {2}--:--:-- {2}viewer1\/vid\s+0s \/ 0s$/);
  });

  it('reads the collection names from the environment', async () => {
    await (await testDb()).collection('my-log').insertOne({ sid: 'custom', updatedAt: at('09:00:00') });
    const { lines } = await run([], { env: { WATCH_LOG_COLLECTION: 'my-log', WATCH_SESSION_COLLECTION: 'my-sess' } });
    expect(lines[1]).toBe('my-log: 1 row(s) match · 0 live session(s) in my-sess');
  });
});

describe('--heatmap', () => {
  const seedHeat = async (doc) => (await testDb()).collection('view-heatmaps').insertOne(doc);

  it('draws the buckets as a sparkline and names the hottest moments', async () => {
    await seedHeat({ owner: 'badadib', permlink: 'abc123', duration: 100, sessions: 3, buckets: [0, 0, 1, 2, 8, 8, 4, 0, 0, 0] });
    const { lines, client } = await run(['--heatmap', 'badadib/abc123']);
    expect(lines).toContain('Heatmap for badadib/abc123  ·  3 session(s)  ·  duration 100s  ·  10 buckets  ·  peak 8 watch(es)');
    expect(lines).toContain('  0s    100s');
    expect(lines).toContain('  ▁▁▁▂██▄▁▁▁');
    const i = lines.indexOf('  most-watched moments:');
    expect(lines.slice(i + 1, i + 4)).toEqual([
      '    00:40  (bucket 4) — 8 watch(es)',
      '    00:50  (bucket 5) — 8 watch(es)',
      '    01:00  (bucket 6) — 4 watch(es)',
    ]);
    expect(client.isClosed).toBe(true);
  });

  it('finds the heatmap through the Hive permlink', async () => {
    await (await testDb()).collection('embed-video').insertOne({ owner: 'badadib', permlink: 'abc123', hive_permlink: 'my-hive-post' });
    await seedHeat({ owner: 'badadib', permlink: 'abc123', duration: 10, sessions: 1, buckets: [1] });
    const { text } = await run(['--heatmap', 'badadib/my-hive-post']);
    expect(text).toContain('Heatmap for badadib/abc123');
  });

  it('says so when there is no heatmap yet', async () => {
    const { text } = await run(['--heatmap', 'badadib/nothing']);
    expect(text).toContain('No heatmap yet for badadib/nothing.');
    await (await testDb()).collection('embed-video').insertOne({ owner: 'badadib', permlink: 'asset9', hive_permlink: 'post9' });
    expect((await run(['--heatmap', 'badadib/post9'])).text).toContain('No heatmap yet for badadib/post9.');
  });

  it('copes with an empty heatmap and missing fields', async () => {
    await seedHeat({ owner: 'badadib', permlink: 'abc123', buckets: [0, 'x', null] });
    const { text } = await run(['--heatmap', 'badadib/abc123']);
    expect(text).toContain('0 session(s)  ·  duration 0s  ·  3 buckets  ·  peak 1 watch(es)');
    expect(text).toContain('  ▁▁▁');
    expect(text).not.toContain('most-watched');
  });
});

describe('-f (live tail)', () => {
  it('prints the rows, then only rows that changed on each poll', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await seedRows();
      const first = await run(['-f'], { until: (out) => out.some((l) => l.includes('sid-three')) });
      expect(first.out[0]).toMatch(/^Live-tailing view-durations \(Ctrl-C to stop\)/);
      const printed = () => first.out.filter((l) => /^\d\d:\d\d:\d\d/.test(l)).length;
      expect(printed()).toBe(3);

      await (await testDb()).collection('view-durations').updateOne({ sid: 'sid-one' }, { $set: { watchedSeconds: 35, updatedAt: at('10:20:00') } });
      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => { if (printed() < 4) throw new Error('waiting for the poll'); }, { timeout: 5000, interval: 5 });
      expect(first.out.at(-1)).toMatch(/^10:20:00 {2}badadib\/abc123\s+embed\s+35/);

      vi.advanceTimersByTime(2000); // nothing changed: nothing new
      await new Promise((r) => setTimeout(r, 50));
      expect(printed()).toBe(4);
      vi.clearAllTimers();
      await first.client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('errors', () => {
  it('logs the error and exits 1', async () => {
    const { errors, exit } = await run([], { env: { MONGODB_URI: 'not-a-mongo-uri' } });
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors[0][0]).toBeInstanceOf(Error);
  });
});
