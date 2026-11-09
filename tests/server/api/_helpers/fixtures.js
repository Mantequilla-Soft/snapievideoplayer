// Seed rows in the shapes server.js reads (db.js collections).
import { testDb } from '../../../helpers/mongo.js';

export const CID = 'QmSK7j5YJfzdKRcziM8wCzKeL4gggW4QJL9fy4GkWc7yKB';
export const HOT = 'https://hotipfs-3speak-1.b-cdn.net/ipfs';
export const SELF = 'https://player.test';

/** The /hls address the API hands out for an upstream manifest. */
export const viaHls = (url, route = 'hls') => `${SELF}/${route}?u=${encodeURIComponent(url)}`;

// Keys set to undefined are left out, so a test can drop a default field.
const compact = (row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));

export async function seedLegacy(doc) {
  const db = await testDb();
  const row = {
    owner: 'badadib',
    status: 'published',
    title: 'A legacy video',
    description: 'About it',
    video_v2: `ipfs://${CID}/manifest.m3u8`,
    thumbnail: 'ipfs://QmLegacyThumb',
    duration: 120,
    views: 7,
    tags_v2: ['hive', 'video'],
    ...doc,
  };
  await db.collection('videos').insertOne(compact(row));
  return row;
}

export async function seedEmbed(doc) {
  const db = await testDb();
  const row = {
    owner: 'badadib',
    status: 'published',
    manifest_cid: CID,
    thumbnail_url: 'https://img.test/thumb.jpg',
    originalFilename: 'clip.mp4',
    duration: 60,
    views: 3,
    short: false,
    encodingProgress: 100,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    updatedAt: new Date('2026-11-01T10:05:00Z'),
    ...doc,
  };
  await db.collection('embed-video').insertOne(compact(row));
  return row;
}

export async function findEmbed(owner, permlink) {
  return (await testDb()).collection('embed-video').findOne({ owner, permlink });
}

export async function findLegacy(owner, permlink) {
  return (await testDb()).collection('videos').findOne({ owner, permlink });
}
