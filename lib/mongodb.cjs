/**
 * Minimal MongoDB connection for the governance engine — the only two functions it uses.
 * (In the AarcadeGh$t app this module is much larger; governance only needs these.)
 * Tests replace it with test/governance/_memoryMongo.cjs, so `npm test` needs no database.
 */
const { MongoClient } = require('mongodb');

const cached = { client: null, promise: null };
const MONGO_DB_NAME = (process.env.MONGO_DB_NAME || 'Gotchinopoly').trim();

async function connect() {
  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) throw new Error('Missing MONGODB_URI environment variable');
  if (cached.client) return cached.client;
  if (!cached.promise) {
    cached.promise = MongoClient.connect(uri).then((client) => {
      cached.client = client;
      return client;
    });
  }
  return cached.promise;
}

/** DAO staff accounts (walletAddress, userType) — used for roles in lib/governance/auth.cjs. */
async function getAdminUsersCollection() {
  return (await connect()).db(MONGO_DB_NAME).collection('admin_users');
}

module.exports = { connect, getAdminUsersCollection };
