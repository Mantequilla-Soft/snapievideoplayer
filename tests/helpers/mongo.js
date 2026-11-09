// Direct access to the per-file test database, for seeding rows and reading
// back what the code wrote. The code under test connects on its own through
// db.js using the same MONGODB_URI / MONGODB_DATABASE.
import { MongoClient } from 'mongodb';

let client;

export async function testDb() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
  }
  return client.db(process.env.MONGODB_DATABASE);
}

// Empty every collection (keeps indexes). Call in beforeEach.
export async function resetDb() {
  const db = await testDb();
  const cols = await db.listCollections().toArray();
  await Promise.all(cols.map((c) => db.collection(c.name).deleteMany({})));
}

export async function closeTestDb() {
  if (client) await client.close();
  client = null;
}
