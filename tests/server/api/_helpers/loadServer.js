// Boots server.js inside the test process and hands back its Express app.
//
// server.js has no exports and calls startServer() on load: db.connect(), then
// app.listen(PORT). We patch express.application.listen first so the call records
// the app and returns a stub instead of binding a port, then require the file.
// The app is served to supertest, which listens on an ephemeral port itself.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// What the server reads at load time (and the placeholder CIDs it reads per request).
export const TEST_ENV = {
  IPFS_GATEWAY: 'https://gw.test/ipfs',
  IPFS_GATEWAY_FALLBACK: 'https://gw-fallback.test/ipfs',
  DEFAULT_THUMBNAIL_CID: 'QmDefaultThumb',
  PLACEHOLDER_PROCESSING_CID: 'ipfs://QmProcessing/manifest.m3u8',
  PLACEHOLDER_FAILED_CID: 'ipfs://QmFailed/manifest.m3u8',
  PLACEHOLDER_DELETED_CID: 'ipfs://QmDeleted/manifest.m3u8',
  HIVE_API: 'https://hive.test',
  STREAM_ENDPOINTS: 'https://hangouts.test|wss://lk1.test, broken-entry ,https://hangouts2.test/|wss://lk2.test',
  LIVE_ROOM_API_URLS: 'https://live.test',
  HLS_FETCH_TIMEOUT_MS: '1000',
  S3_BUCKET: 'videos-test',
  S3_FETCH_TIMEOUT_MS: '300',
  IPFS_PROXY_HEADER_TIMEOUT_MS: '1000',
  VIEW_IP_HASH_SECRET: 'view-hash-test-secret',
};

let booting = null;

/** Resolves to the Express app once server.js has connected to Mongo. */
export function loadServer() {
  if (booting) return booting;
  Object.assign(process.env, TEST_ENV);
  const express = require('express');
  const proto = express.application;
  const realListen = proto.listen;
  booting = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server.js never reached app.listen')), 30000);
    proto.listen = function captureListen() {
      proto.listen = realListen;
      clearTimeout(timer);
      resolve(this);
      return { close: (cb) => cb && cb(), on() { return this; }, address: () => null };
    };
  });
  require(path.join(ROOT, 'server.js'));
  return booting;
}

/** The same db.js instance server.js uses. */
export function serverDb() {
  return require(path.join(ROOT, 'db.js'));
}

/** Closes the server's Mongo client so the worker can exit cleanly. */
export async function stopServer() {
  await serverDb().close();
}
