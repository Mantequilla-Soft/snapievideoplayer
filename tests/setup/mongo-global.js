// One in-memory mongod for the whole run. Each test file gets its own
// database name (see tests/helpers/mongo.js), so files never see each
// other's rows even when they run in parallel.
import { MongoMemoryServer } from 'mongodb-memory-server';

let server;

export async function setup({ provide }) {
  server = await MongoMemoryServer.create({ binary: { version: process.env.MONGOMS_VERSION || "7.0.24" } });
  provide('mongoUri', server.getUri());
}

export async function teardown() {
  if (server) await server.stop();
}
