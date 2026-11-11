// Runs before every server-side test file.
//
// 1. No real secrets: dotenv is a no-op under test, and every variable the
//    code reads is set to a known test value here (tests override per case
//    with vi.stubEnv, which is undone after each test).
// 2. No real network: global fetch throws unless a test stubs it, so a
//    missed mock fails loudly instead of calling Hive or an IPFS gateway.
import { createRequire } from 'node:module';
import { inject } from 'vitest';

const require = createRequire(import.meta.url);

// dotenv must not load the developer's .env into a test run.
require('dotenv').config = () => ({ parsed: {} });

for (const key of Object.keys(process.env)) {
  if (/SECRET|KEY|TOKEN|PASSWORD|MONGODB_|AD_|INCUBATION_|WATCH_|IP_HASH|PLACEHOLDER_|IPFS_|S3_|HIVE_|LIVE_|STREAM_|PUBLIC_BASE_URL|HLS_/.test(key)) {
    delete process.env[key];
  }
}

const dbName = `snapie_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGODB_URI: inject('mongoUri'),
  MONGODB_DATABASE: dbName,
  MONGODB_COLLECTION_NEW: 'embed-video',
  MONGODB_COLLECTION_LEGACY: 'videos',
  MONGODB_COLLECTION_VIEWS: 'views',
  PUBLIC_BASE_URL: 'https://player.test',
});

globalThis.fetch = async (url) => {
  throw new Error(`Unmocked fetch in a test: ${url}. Stub it with vi.stubGlobal('fetch', ...).`);
};
