const { MongoClient } = require('mongodb');
require('dotenv').config();

let client = null;
let db = null;

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
  
  // First, check if views field exists, if not set it to 0, then increment
  await collection.updateOne(
    { owner: owner, permlink: permlink, views: { $exists: false } },
    { $set: { views: 0 } }
  );
  
  // Now increment views
  const result = await collection.updateOne(
    { owner: owner, permlink: permlink },
    { $inc: { views: 1 } }
  );
  
  return result.modifiedCount > 0;
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
  close
};
