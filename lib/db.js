const { MongoClient } = require('mongodb');

let client;
let db;

async function connectDB() {
  if (db) return db;
  client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('drivebot');
  // Indexes
  await db.collection('users').createIndex({ telegramId: 1 }, { unique: true });
  await db.collection('uploads').createIndex({ telegramId: 1 });
  await db.collection('uploads').createIndex({ fileId: 1 });
  await db.collection('uploads').createIndex({ checksum: 1 });
  await db.collection('queue').createIndex({ telegramId: 1, status: 1 });
  return db;
}

module.exports = { connectDB };
