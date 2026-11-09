import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { requireFresh } from './_helpers/load.js';
import { testDb, resetDb, closeTestDb } from '../../helpers/mongo.js';

const EMBED = process.env.MONGODB_COLLECTION_NEW;
const LEGACY = process.env.MONGODB_COLLECTION_LEGACY;

// Plain db module (no IP hash secret) plus one loaded with a secret.
const db = requireFresh('db.js', { VIEW_IP_HASH_SECRET: undefined });
const SECRET = 'test-view-ip-secret';
const dbWithSecret = requireFresh('db.js', { VIEW_IP_HASH_SECRET: SECRET });

const col = async (name) => (await testDb()).collection(name);

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await db.connect();
  await dbWithSecret.connect();
});
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await resetDb();
});
afterAll(async () => {
  await db.close();
  await dbWithSecret.close();
  await closeTestDb();
});

describe('connect / getDb / close', () => {
  it('getDb throws until connect() has run', () => {
    const fresh = requireFresh('db.js');
    expect(() => fresh.getDb()).toThrow('Database not connected. Call connect() first.');
  });

  it('connects once and hands back the same handle', async () => {
    const first = await db.connect();
    expect(await db.connect()).toBe(first);
    expect(db.getDb()).toBe(first);
    expect(first.databaseName).toBe(process.env.MONGODB_DATABASE);
  });

  it('ensures the owner + hive_permlink index on the embed collection', async () => {
    const indexes = await (await col(EMBED)).indexes();
    expect(indexes.map((i) => i.key)).toContainEqual({ owner: 1, hive_permlink: 1 });
  });

  it('logs and rethrows a connection error, and stays unconnected', async () => {
    const fresh = requireFresh('db.js');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('MONGODB_URI', 'not-a-mongo-uri');
    await expect(fresh.connect()).rejects.toThrow();
    expect(err).toHaveBeenCalledWith('MongoDB connection error:', expect.any(Error));
    expect(() => fresh.getDb()).toThrow(/not connected/);
  });

  it('close() disconnects, is safe to repeat, and connect() works again', async () => {
    const fresh = requireFresh('db.js');
    await fresh.connect();
    await fresh.close();
    expect(() => fresh.getDb()).toThrow(/not connected/);
    await fresh.close(); // no client: a no-op
    const again = await fresh.connect();
    expect(again.databaseName).toBe(process.env.MONGODB_DATABASE);
    await fresh.close();
  });
});

describe('findLegacyVideo', () => {
  it('finds by owner and permlink', async () => {
    await (await col(LEGACY)).insertMany([
      { owner: 'badadib', permlink: 'old1', title: 'mine' },
      { owner: 'viewer1', permlink: 'old1', title: 'theirs' },
    ]);
    expect((await db.findLegacyVideo('badadib', 'old1')).title).toBe('mine');
  });

  it('returns null when there is no match', async () => {
    expect(await db.findLegacyVideo('badadib', 'missing')).toBeNull();
  });
});

describe('findEmbedVideo', () => {
  it('prefers the 3speak permlink', async () => {
    await (await col(EMBED)).insertMany([
      { owner: 'badadib', permlink: 'other', hive_permlink: 'abc', title: 'hive match' },
      { owner: 'badadib', permlink: 'abc', title: 'permlink match' },
    ]);
    expect((await db.findEmbedVideo('badadib', 'abc')).title).toBe('permlink match');
  });

  it('falls back to the Hive permlink', async () => {
    await (await col(EMBED)).insertOne({ owner: 'badadib', permlink: 'asset1', hive_permlink: 'my-post' });
    expect((await db.findEmbedVideo('badadib', 'my-post')).permlink).toBe('asset1');
  });

  it.each(['null', 'undefined', 'unknown', ''])(
    'falls back to an asset stored under the broken owner %j, matched by its Hive link',
    async (broken) => {
      await (await col(EMBED)).insertOne({ owner: broken, permlink: 'asset2', hive_author: 'badadib', hive_permlink: 'my-post' });
      expect((await db.findEmbedVideo('badadib', 'my-post')).permlink).toBe('asset2');
    },
  );

  it('never hands over an asset that a real other account owns', async () => {
    await (await col(EMBED)).insertOne({ owner: 'viewer1', permlink: 'asset3', hive_author: 'badadib', hive_permlink: 'my-post' });
    expect(await db.findEmbedVideo('badadib', 'my-post')).toBeNull();
  });
});

describe('incrementLegacyViews', () => {
  it('adds one view and reports success', async () => {
    const c = await col(LEGACY);
    await c.insertOne({ owner: 'badadib', permlink: 'old1', views: 4 });
    expect(await db.incrementLegacyViews('badadib', 'old1')).toBe(true);
    expect((await c.findOne({ permlink: 'old1' })).views).toBe(5);
  });

  it('reports false when the video does not exist', async () => {
    expect(await db.incrementLegacyViews('badadib', 'missing')).toBe(false);
  });
});

describe('incrementEmbedViews', () => {
  it('starts a missing counter at 1', async () => {
    const c = await col(EMBED);
    await c.insertOne({ owner: 'badadib', permlink: 'asset1' });
    expect(await db.incrementEmbedViews('badadib', 'asset1')).toBe(true);
    expect((await c.findOne({ permlink: 'asset1' })).views).toBe(1);
  });

  it('adds to an existing counter, found by permlink or Hive permlink', async () => {
    const c = await col(EMBED);
    await c.insertOne({ owner: 'badadib', permlink: 'asset1', hive_permlink: 'my-post', views: 10 });
    await db.incrementEmbedViews('badadib', 'asset1');
    await db.incrementEmbedViews('badadib', 'my-post');
    expect((await c.findOne({ permlink: 'asset1' })).views).toBe(12);
  });

  it('counts a view on a broken-owner asset, like findEmbedVideo resolves it', async () => {
    const c = await col(EMBED);
    await c.insertOne({ owner: 'null', permlink: 'asset2', hive_author: 'badadib', hive_permlink: 'my-post' });
    expect(await db.incrementEmbedViews('badadib', 'my-post')).toBe(true);
    expect((await c.findOne({ permlink: 'asset2' })).views).toBe(1);
  });

  it('reports false and writes nothing when no video matches', async () => {
    const c = await col(EMBED);
    await c.insertOne({ owner: 'viewer1', permlink: 'asset1' });
    expect(await db.incrementEmbedViews('badadib', 'asset1')).toBe(false);
    expect(await c.findOne({ permlink: 'asset1' })).not.toHaveProperty('views');
  });
});

describe('updateEmbedDuration', () => {
  const seed = async (doc) => (await col(EMBED)).insertOne({ owner: 'badadib', permlink: 'asset1', hive_permlink: 'my-post', ...doc });
  const stored = async () => (await (await col(EMBED)).findOne({ permlink: 'asset1' })).duration;

  it('fills a missing or zero duration', async () => {
    await seed({});
    expect(await db.updateEmbedDuration('badadib', 'asset1', 120)).toBe(true);
    expect(await stored()).toBe(120);
  });

  it('grows a too-small duration', async () => {
    await seed({ duration: 0 });
    await db.updateEmbedDuration('badadib', 'asset1', 6);
    expect(await db.updateEmbedDuration('badadib', 'asset1', 120)).toBe(true);
    expect(await stored()).toBe(120);
  });

  it('refuses to shrink a stored duration below half, and warns', async () => {
    await seed({ duration: 120 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await db.updateEmbedDuration('badadib', 'asset1', 6)).toBe(false);
    expect(await stored()).toBe(120);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refusing to shrink badadib/asset1: stored=120s proposed=6s'));
  });

  it('allows a correction down to half of the stored value', async () => {
    await seed({ duration: 120 });
    expect(await db.updateEmbedDuration('badadib', 'asset1', 60)).toBe(true);
    expect(await stored()).toBe(60);
  });

  it('treats an unreadable stored value as missing', async () => {
    await seed({ duration: 'abc' });
    expect(await db.updateEmbedDuration('badadib', 'asset1', 5)).toBe(true);
    expect(await stored()).toBe(5);
  });

  it('updates through the Hive permlink when the 3speak permlink does not match', async () => {
    await seed({ duration: 100 });
    expect(await db.updateEmbedDuration('badadib', 'my-post', 101)).toBe(true);
    expect(await stored()).toBe(101);
  });

  it('reports false when nothing changed or nothing matched', async () => {
    await seed({ duration: 100 });
    expect(await db.updateEmbedDuration('badadib', 'asset1', 100)).toBe(false);
    expect(await db.updateEmbedDuration('badadib', 'missing', 100)).toBe(false);
  });
});

describe('logEmbedView', () => {
  const views = async () => (await col(process.env.MONGODB_COLLECTION_VIEWS)).find().toArray();

  it('writes one row shaped like the legacy views collection, without the IP', async () => {
    const before = Date.now();
    await db.logEmbedView('badadib', 'asset1', '203.0.113.7', 'agent/1.0');
    const [row] = await views();
    expect(row).toMatchObject({ author: 'badadib', permlink: 'asset1', ipHash: null, userAgent: 'agent/1.0', __v: 0 });
    expect(row.timestamp.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
  });

  it('with a secret, stores a keyed per-video hash of the IP', async () => {
    await dbWithSecret.logEmbedView('badadib', 'asset1', '203.0.113.7', 'ua');
    await dbWithSecret.logEmbedView('badadib', 'asset2', '203.0.113.7', 'ua');
    const [a, b] = await views();
    const expected = crypto.createHmac('sha256', SECRET).update('203.0.113.7|asset1').digest('hex').slice(0, 32);
    expect(a.ipHash).toBe(expected);
    expect(a.ipHash).toHaveLength(32);
    expect(b.ipHash).not.toBe(a.ipHash); // same IP, other video: not linkable
  });

  it('stores no hash for a missing or unknown IP, even with a secret', async () => {
    await dbWithSecret.logEmbedView('badadib', 'asset1', 'unknown', 'ua');
    await dbWithSecret.logEmbedView('badadib', 'asset1', '', 'ua');
    expect((await views()).map((r) => r.ipHash)).toEqual([null, null]);
  });

  it('writes to the configured views collection', async () => {
    vi.stubEnv('MONGODB_COLLECTION_VIEWS', 'custom-views');
    await db.logEmbedView('badadib', 'asset1', '1.2.3.4', 'ua');
    expect(await (await col('custom-views')).countDocuments()).toBe(1);
  });

  it('writes to "views" when no collection is configured', async () => {
    vi.stubEnv('MONGODB_COLLECTION_VIEWS', '');
    await db.logEmbedView('badadib', 'asset1', '1.2.3.4', 'ua');
    expect(await (await col('views')).countDocuments()).toBe(1);
  });
});
