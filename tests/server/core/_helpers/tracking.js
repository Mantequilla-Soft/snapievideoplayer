// Shared setup for the watchTracking.js suites: a fake geoip-lite, partner token
// minting, a fake streaming server, and a driver that opens a session and sends
// beats on a controlled clock (only Date is faked, so the Mongo driver keeps
// its real timers).
import crypto from 'node:crypto';
import { vi } from 'vitest';
import { call } from './http.js';
import { requireFresh, stubPackage, rootPath, require } from './load.js';
import { testDb } from '../../../helpers/mongo.js';

/** IP -> country the fake geoip knows. 192.0.2.66 makes lookup throw. */
export const GEO = { '203.0.113.7': 'US', '198.51.100.9': 'DE', '2001:db8::1': 'FR' };
export const THROWING_IP = '192.0.2.66';

export const geoCalls = [];
export function installFakeGeoip() {
  return stubPackage('geoip-lite', {
    lookup(ip) {
      geoCalls.push(ip);
      if (ip === THROWING_IP) throw new Error('corrupt geo db');
      return GEO[ip] ? { country: GEO[ip], city: 'nowhere' } : null;
    },
  });
}

export const PARTNER_SECRET = 'p'.repeat(32);
export const OTHER_SECRET = 'o'.repeat(30);

const b64url = (v) => Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A partner-signed viewer token, as a partner backend would mint it. */
export function mintToken({ v = 'viewer1', a = 'partnerapp', p = 'badadib/abc123', ttl = 600, e, secret = PARTNER_SECRET, raw } = {}) {
  const claims = raw ?? { v, a, p, e: e ?? Math.floor(Date.now() / 1000) + ttl };
  const payload = b64url(typeof claims === 'string' ? claims : JSON.stringify(claims));
  const sig = b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * Load watchTracking.js fresh (after the fake geoip) with `env` set while it
 * loads, and connect the shared db module.
 */
export async function loadTracking(env = {}) {
  installFakeGeoip();
  const wt = requireFresh('watchTracking.js', env);
  const db = require(rootPath('db.js'));
  await db.connect();
  return { wt, db };
}

/** The standard embed video used across suites. */
export const VIDEO = { owner: 'badadib', permlink: 'abc123', hive_permlink: 'my-hive-post', duration: 40, status: 'published' };

export async function seedVideo(over = {}, collection = process.env.MONGODB_COLLECTION_NEW) {
  const d = await testDb();
  const doc = { ...VIDEO, ...over };
  await d.collection(collection).insertOne(doc);
  return doc;
}

export async function optIn(viewer, rewardsEnabled = true, collection = 'ad_viewer_prefs') {
  await (await testDb()).collection(collection).insertOne({ _id: viewer, rewardsEnabled });
}

export const rows = async (name, filter = {}) => (await testDb()).collection(name).find(filter).toArray();
export const one = async (name, filter = {}) => (await testDb()).collection(name).findOne(filter);

/** Freeze Date at the real current time; advance with tick(ms). */
export function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
}
export const tick = (ms) => vi.setSystemTime(Date.now() + ms);

export const HEADERS = { 'x-real-ip': '203.0.113.7', 'user-agent': 'vitest-agent' };

/** Opens sessions and sends beats against a loaded watchTracking module. */
export function driver(wt) {
  async function start(body = {}, headers = HEADERS) {
    return call(wt.watchStart, {
      body: { owner: VIDEO.owner, permlink: VIDEO.permlink, type: 'embed', ...body },
      headers,
    });
  }
  /** One beat `after` ms after the previous one. */
  async function beat(session, { after = 5000, headers = HEADERS, ...body } = {}) {
    tick(after);
    return call(wt.watchBeat, { body: { sid: session.sid, token: session.token, ...body }, headers });
  }
  /** Contiguous playback from `from` to `to` seconds, one beat per `step`. */
  async function play(session, from, to, { step = 5, ...extra } = {}) {
    let last;
    for (let p = from + step; p <= to + 1e-9; p += step) {
      last = await beat(session, { after: step * 1000, position: Math.min(p, to), ...extra });
    }
    return last;
  }
  return { start, beat, play };
}

/** A fake streaming server for GET /rooms/:name. `room` null = 404, 'error' = down. */
export const LIVE_AT = '2026-11-09T18:00:00.000Z';
export const liveRoomDoc = (over = {}) => ({ name: 'room-1', mode: 'standalone', host: 'host1', broadcasting: true, liveAt: LIVE_AT, ...over });

export function streamingServer(initial = liveRoomDoc()) {
  const server = { room: initial, byBase: null, calls: [] };
  server.fetch = async (url) => {
    server.calls.push(String(url));
    const base = String(url).split('/rooms/')[0];
    const answer = server.byBase && base in server.byBase ? server.byBase[base] : server.room;
    if (answer === 'error') throw new Error('connect ECONNREFUSED');
    if (answer === 500) return { ok: false, status: 500, json: async () => ({}) };
    if (!answer) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  };
  vi.stubGlobal('fetch', server.fetch);
  return server;
}
