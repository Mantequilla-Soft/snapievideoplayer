const { MongoClient } = require('mongodb');
const crypto = require('crypto');
require('dotenv').config();

let client = null;
let db = null;

/**
 * Keyed, PER-VIDEO hash of a viewer IP, for counting unique views without keeping
 * the address. Replaces the raw `userIP` column on `views` (2026-07-14).
 *
 * The permlink is mixed into the input on purpose. The same IP therefore produces a
 * DIFFERENT hash for every video, which means:
 *   • unique views per video still work exactly (distinct ipHash within one video);
 *   • linking a viewer ACROSS videos is impossible — there is no stable per-person
 *     identifier in the collection to build a viewing profile from.
 * That is the property a plain hash(ip) would throw away for no benefit.
 *
 * BE HONEST ABOUT WHAT THIS IS: pseudonymisation, not anonymisation. IPv4 is only
 * 2^32 addresses, so anyone holding VIEW_IP_HASH_SECRET can brute-force the whole
 * space and rebuild the mapping. These rows remain personal data under the GDPR —
 * the hash raises the cost of misuse, it does not put `views` out of scope. Treat it
 * as a bridge while the watch-duration records take over, not an end state.
 *
 * The secret must NOT live in the database it protects. No secret configured → we
 * store no hash at all rather than a trivially reversible unsalted digest.
 */
const VIEW_IP_HASH_SECRET = process.env.VIEW_IP_HASH_SECRET || '';

function hashViewerIp(ip, permlink) {
  if (!VIEW_IP_HASH_SECRET || !ip || ip === 'unknown') return null;
  return crypto.createHmac('sha256', VIEW_IP_HASH_SECRET)
    .update(`${ip}|${permlink}`)
    .digest('hex')
    .slice(0, 32); // 128 bits — collision-free at this scale, half the storage
}

/**
 * Connect to MongoDB
 */
async function connect() {
  if (db) {
    return db;
  }

  try {
    client = new MongoClient(process.env.MONGODB_URI);

    await client.connect();
    console.log('✓ Connected to MongoDB');

    db = client.db(process.env.MONGODB_DATABASE);

    // Ensure indexes (no-ops if they already exist)
    await db.collection(process.env.MONGODB_COLLECTION_NEW).createIndex(
      { owner: 1, hive_permlink: 1 }
    );

    return db;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

/**
 * Get database instance
 */
function getDb() {
  if (!db) {
    throw new Error('Database not connected. Call connect() first.');
  }
  return db;
}

/**
 * Find video in legacy collection by owner and permlink
 */
async function findLegacyVideo(owner, permlink) {
  const database = getDb();
  const collection = database.collection(process.env.MONGODB_COLLECTION_LEGACY);
  
  return await collection.findOne({
    owner: owner,
    permlink: permlink
  });
}

/**
 * Find video in embed collection by owner and permlink.
 * Falls back to hive_permlink when the 3speak permlink doesn't match.
 */
async function findEmbedVideo(owner, permlink) {
  const database = getDb();
  const collection = database.collection(process.env.MONGODB_COLLECTION_NEW);

  const video = await collection.findOne({
    owner: owner,
    permlink: permlink
  });

  if (!video) {
    return await collection.findOne({
      owner: owner,
      hive_permlink: permlink
    });
  }

  return video;
}

/**
 * Increment view count for legacy video
 */
async function incrementLegacyViews(owner, permlink) {
  const database = getDb();
  const collection = database.collection(process.env.MONGODB_COLLECTION_LEGACY);
  
  const result = await collection.updateOne(
    { owner: owner, permlink: permlink },
    { $inc: { views: 1 } }
  );
  
  return result.modifiedCount > 0;
}

/**
 * Increment view count for embed video
 * Note: Initializes views field to 1 if it doesn't exist on that document
 */
async function incrementEmbedViews(owner, permlink) {
  const database = getDb();
  const collection = database.collection(process.env.MONGODB_COLLECTION_NEW);

  const filter = {
    owner: owner,
    $or: [{ permlink: permlink }, { hive_permlink: permlink }]
  };

  // Initialize views field if it doesn't exist, then increment
  await collection.updateOne(
    { ...filter, views: { $exists: false } },
    { $set: { views: 0 } }
  );

  const result = await collection.updateOne(
    filter,
    { $inc: { views: 1 } }
  );

  return result.modifiedCount > 0;
}

/**
 * Update duration for an embed video (self-healing)
 * Only updates if the current duration is null, 0, or differs from the real duration
 */
async function updateEmbedDuration(owner, permlink, duration) {
  const database = getDb();
  const collection = database.collection(process.env.MONGODB_COLLECTION_NEW);

  const update = { $set: { duration } };
  let result = await collection.updateOne(
    { owner, permlink },
    update
  );

  if (result.matchedCount === 0) {
    result = await collection.updateOne(
      { owner, hive_permlink: permlink },
      update
    );
  }

  return result.modifiedCount > 0;
}

/**
 * Log a per-event view row for an embed video.
 * Mirrors the shape of the legacy `views` collection so both can be queried
 * together. Note: the views collection keys on `author`, not `owner`.
 *
 * The raw IP is hashed on the way in (see hashViewerIp) and never stored. Unique
 * views per video are still countable — `db.views.distinct('ipHash', {permlink})`
 * — but the address is gone and no viewer can be followed between videos.
 */
async function logEmbedView(owner, permlink, userIP, userAgent) {
  const database = getDb();
  const collection = database.collection(process.env.MONGODB_COLLECTION_VIEWS || 'views');

  await collection.insertOne({
    timestamp: new Date(),
    author: owner,
    permlink: permlink,
    ipHash: hashViewerIp(userIP, permlink),
    userAgent: userAgent,
    __v: 0
  });
}

/**
 * Close MongoDB connection
 */
async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('✓ MongoDB connection closed');
  }
}

module.exports = {
  connect,
  getDb,
  findLegacyVideo,
  findEmbedVideo,
  incrementLegacyViews,
  incrementEmbedViews,
  updateEmbedDuration,
  logEmbedView,
  close
};
