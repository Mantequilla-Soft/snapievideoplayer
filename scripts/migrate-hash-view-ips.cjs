#!/usr/bin/env node
/**
 * Replace the raw `userIP` on the `views` collection with a keyed, per-video hash.
 *
 *   node scripts/migrate-hash-view-ips.cjs --dry-run   # report only
 *   node scripts/migrate-hash-view-ips.cjs             # apply
 *
 * Why hash instead of just dropping the column (which is what we did for
 * view-durations): the `views` table is still the source of truth for view counts
 * while the watch-duration records ramp up, and a hash keeps "unique views per
 * video" computable — `db.views.distinct('ipHash', { permlink })` — where dropping
 * the field outright would not.
 *
 * The hash is scoped per video (HMAC over `ip|permlink`), so one IP yields a
 * different hash on every video. Unique-per-video counting works; following a
 * viewer between videos does not.
 *
 * HONESTY NOTE: this is pseudonymisation, not anonymisation. IPv4 is 2^32 — with
 * VIEW_IP_HASH_SECRET the mapping is brute-forceable. These rows stay personal data
 * under the GDPR; the hash raises the cost of misuse and removes the plaintext, but
 * it does not take `views` out of scope. It is a bridge, not the destination.
 *
 * Idempotent and resumable: only rows that still have `userIP` are touched, so an
 * interrupted run can simply be re-run. Batched to keep the working set small
 * against 7.2M+ documents on a shared Mongo.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const DRY_RUN = process.argv.includes('--dry-run');
const COLLECTION = process.env.MONGODB_COLLECTION_VIEWS || 'views';
const SECRET = process.env.VIEW_IP_HASH_SECRET || '';
const BATCH = 5000;

if (!SECRET) {
  console.error('VIEW_IP_HASH_SECRET is not set. Refusing to run: an unsalted digest of an');
  console.error('IP is trivially reversible with a rainbow table and would be worse than useless.');
  process.exit(1);
}

const hashViewerIp = (ip, permlink) => {
  if (!ip || ip === 'unknown') return null;
  return crypto.createHmac('sha256', SECRET).update(`${ip}|${permlink}`).digest('hex').slice(0, 32);
};

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'threespeak');
  const coll = db.collection(COLLECTION);

  const todo = await coll.countDocuments({ userIP: { $exists: true } });
  console.log(DRY_RUN ? '=== DRY RUN — no writes ===' : '=== APPLYING ===');
  console.log(`${COLLECTION}: ${todo.toLocaleString()} row(s) still carry a raw userIP\n`);
  if (!todo) { await client.close(); return; }

  let scanned = 0, hashed = 0, noIp = 0, ops = [];
  const started = Date.now();

  const flush = async () => {
    if (!ops.length) return;
    if (!DRY_RUN) await coll.bulkWrite(ops, { ordered: false });
    ops = [];
  };

  const cursor = coll.find({ userIP: { $exists: true } }, { projection: { _id: 1, userIP: 1, permlink: 1 } });

  for await (const doc of cursor) {
    scanned += 1;
    const h = hashViewerIp(doc.userIP, doc.permlink || '');
    if (h) hashed += 1; else noIp += 1;

    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          ...(h ? { $set: { ipHash: h } } : {}),
          $unset: { userIP: '' },   // the raw address goes, always
        },
      },
    });

    if (ops.length >= BATCH) {
      await flush();
      if (scanned % 100000 === 0) {
        const rate = Math.round(scanned / ((Date.now() - started) / 1000));
        console.log(`  ${scanned.toLocaleString()} / ${todo.toLocaleString()}  (${rate.toLocaleString()}/s)`);
      }
    }
  }
  await flush();

  console.log(`\n  scanned:  ${scanned.toLocaleString()}`);
  console.log(`  hashed:   ${hashed.toLocaleString()}`);
  console.log(`  no usable ip (userIP null/unknown): ${noIp.toLocaleString()}`);

  if (!DRY_RUN) {
    // Unique-views-per-video is the whole reason the hash exists — index for it.
    await coll.createIndex({ permlink: 1, ipHash: 1 }, { background: true });
    console.log('  created index { permlink: 1, ipHash: 1 } for unique-view counts');
  }

  const left = await coll.countDocuments({ userIP: { $exists: true } });
  console.log(`\nRemaining rows with a raw userIP: ${left.toLocaleString()}`);

  await client.close();
})().catch((e) => { console.error('migration failed:', e); process.exit(1); });
