const { connectDB } = require('./db');

async function getUser(telegramId) {
  const db = await connectDB();
  return db.collection('users').findOne({ telegramId: String(telegramId) });
}

async function saveUser(telegramId, data) {
  const db = await connectDB();
  await db.collection('users').updateOne(
    { telegramId: String(telegramId) },
    { $set: { ...data, telegramId: String(telegramId), updatedAt: new Date() } },
    { upsert: true }
  );
}

async function deleteUser(telegramId) {
  const db = await connectDB();
  await db.collection('users').deleteOne({ telegramId: String(telegramId) });
}

async function isSetup(telegramId) {
  const user = await getUser(telegramId);
  return !!(user && user.clientId && user.clientSecret && user.refreshToken);
}

async function getUserCredentials(telegramId) {
  const user = await getUser(telegramId);
  if (!user) return null;
  return {
    clientId: user.clientId,
    clientSecret: user.clientSecret,
    refreshToken: user.refreshToken,
    autoOrganize: user.autoOrganize || false,
    defaultFolderId: user.defaultFolderId || null,
    storageAlert: user.storageAlert || 90,
  };
}

async function setAutoOrganize(telegramId, enabled) {
  await saveUser(telegramId, { autoOrganize: enabled });
}

async function setDefaultFolder(telegramId, folderId, folderName) {
  await saveUser(telegramId, { defaultFolderId: folderId, defaultFolderName: folderName });
}

// Upload history
async function saveUpload(telegramId, fileData) {
  const db = await connectDB();
  await db.collection('uploads').insertOne({
    telegramId: String(telegramId),
    ...fileData,
    uploadedAt: new Date(),
  });
}

async function getUploadHistory(telegramId, page = 0, limit = 5) {
  const db = await connectDB();
  const skip = page * limit;
  const total = await db.collection('uploads').countDocuments({ telegramId: String(telegramId) });
  const items = await db.collection('uploads')
    .find({ telegramId: String(telegramId) })
    .sort({ uploadedAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();
  return { items, total, pages: Math.ceil(total / limit) };
}

async function getUploadStats(telegramId) {
  const db = await connectDB();
  const total = await db.collection('uploads').countDocuments({ telegramId: String(telegramId) });
  const byType = await db.collection('uploads').aggregate([
    { $match: { telegramId: String(telegramId) } },
    { $group: { _id: '$category', count: { $sum: 1 }, totalSize: { $sum: { $toLong: '$size' } } } },
  ]).toArray();
  const totalSize = byType.reduce((sum, t) => sum + (t.totalSize || 0), 0);
  return { total, byType, totalSize };
}

async function checkDuplicateInHistory(telegramId, checksum, fileName, fileSize) {
  const db = await connectDB();
  if (checksum) {
    const byHash = await db.collection('uploads').findOne({ telegramId: String(telegramId), checksum });
    if (byHash) return byHash;
  }
  return db.collection('uploads').findOne({ telegramId: String(telegramId), fileName, size: String(fileSize) });
}

module.exports = {
  getUser, saveUser, deleteUser, isSetup, getUserCredentials,
  setAutoOrganize, setDefaultFolder,
  saveUpload, getUploadHistory, getUploadStats, checkDuplicateInHistory,
};
