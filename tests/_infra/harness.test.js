// Self-checks for the test harness itself.
import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { testDb, closeTestDb } from '../helpers/mongo.js';

const require = createRequire(import.meta.url);

describe('test harness', () => {
  afterAll(closeTestDb);

  it('points at a throwaway in-memory database, never a real one', () => {
    expect(process.env.MONGODB_URI).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\//);
    expect(process.env.MONGODB_DATABASE).toMatch(/^snapie_test_/);
  });

  it('blocks unmocked network calls', async () => {
    await expect(fetch('https://api.hive.blog')).rejects.toThrow(/Unmocked fetch/);
  });

  it('can load the CommonJS modules and reach the database', async () => {
    const { isPlaceholderStatus } = require('../../videoStatus.js');
    expect(typeof isPlaceholderStatus).toBe('function');
    const db = await testDb();
    await db.collection('probe').insertOne({ a: 1 });
    expect(await db.collection('probe').countDocuments()).toBe(1);
  });
});
