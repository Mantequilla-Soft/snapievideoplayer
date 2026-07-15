#!/usr/bin/env node
/**
 * One-off migration: strip viewer IPs out of the watch-tracking collections.
 *
 * Rows written before 2026-07-14 carry a raw `ip` (and a `viewerId`, which was a
 * persistent per-browser device id). Both are personal data. This script:
 *
 *   1. resolves each legacy row's `ip` to an ISO country code, using the SAME
 *      local GeoLite2 database the ingest path now uses — so historical country
 *      demographics survive the change instead of going blank;
 *   2. $unsets `ip` and `viewerId`;
 *   3. drops the { ip: 1, updatedAt: -1 } index.
 *
 * Idempotent: rows already migrated (no `ip`) are skipped, so a re-run is a no-op.
 *
 *   node scripts/migrate-drop-ips.cjs --dry-run   # report only, change nothing
 *   node scripts/migrate-drop-ips.cjs             # apply
 *
 * NOTE: deliberately does NOT touch the `views` collection (7.2M rows with a
 * `userIP`) — that one is a separate, still-open decision.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const geoip = require('geoip-lite');

const DRY_RUN = process.argv.includes('--dry-run');
const LOG_COLLECTION = process.env.WATCH_LOG_COLLECTION || 'view-durations';
const SESSION_COLLECTION = process.env.WATCH_SESSION_COLLECTION || 'view-sessions';
const BATCH = 1000;

function countryOf(ip) {
  if (!ip || ip === 'unknown') return null;
  try {
    const g = geoip.lookup(ip);
    return (g && g.country) ? g.country : null;
  } catch {
    return null;
  }
}

async function migrate(db, name) {
  const coll = db.collection(name);
  const todo = await coll.countDocuments({ ip: { $exists: true } });
  if (!todo) {
    console.log(`  ${name}: nothing to do (no rows carry an ip)`);
    return { located: 0, unlocated: 0, cleared: 0 };
  }
  console.log(`  ${name}: ${todo} row(s) carry an ip`);

  let located = 0, unlocated = 0, cleared = 0, ops = [];
  const cursor = coll.find({ ip: { $exists: true } }, { projection: { _id: 1, ip: 1, country: 1 } });

  const flush = async () => {
    if (!ops.length || DRY_RUN) { cleared += ops.length; ops = []; return; }
    const res = await coll.bulkWrite(ops, { ordered: false });
    cleared += res.modifiedCount;
    ops = [];
  };

  for await (const doc of cursor) {
    const country = doc.country ?? countryOf(doc.ip); // keep a country already set
    if (country) located += 1; else unlocated += 1;

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          ...(country ? { $set: { country } } : {}),
          $unset: { ip: '', viewerId: '' },
        },
      },
    });
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  console.log(`    → ${located} geolocated, ${unlocated} unlocatable (country stays null), ${cleared} row(s) ${DRY_RUN ? 'would be' : ''} cleared`);
  return { located, unlocated, cleared };
}

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'threespeak');

  console.log(DRY_RUN ? '=== DRY RUN — no writes ===' : '=== APPLYING ===');

  await migrate(db, LOG_COLLECTION);
  await migrate(db, SESSION_COLLECTION);

  if (!DRY_RUN) {
    try {
      await db.collection(LOG_COLLECTION).dropIndex('ip_1_updatedAt_-1');
      console.log(`  ${LOG_COLLECTION}: dropped index ip_1_updatedAt_-1`);
    } catch {
      console.log(`  ${LOG_COLLECTION}: index ip_1_updatedAt_-1 already absent`);
    }
  }

  // Prove it: nothing with an ip may remain.
  const leftLog = await db.collection(LOG_COLLECTION).countDocuments({ ip: { $exists: true } });
  const leftSess = await db.collection(SESSION_COLLECTION).countDocuments({ ip: { $exists: true } });
  console.log(`\nRemaining rows with an ip → ${LOG_COLLECTION}: ${leftLog}, ${SESSION_COLLECTION}: ${leftSess}`);

  await client.close();
})().catch((e) => { console.error('migration failed:', e); process.exit(1); });
