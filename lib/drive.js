const { google } = require('googleapis');

function getOAuthClient(credentials) {
  const oauth2Client = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: credentials.refreshToken });
  return oauth2Client;
}

function getDriveClient(credentials) {
  return google.drive({ version: 'v3', auth: getOAuthClient(credentials) });
}

function shareLink(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
}
function downloadLink(fileId) {
  return `https://drive.google.com/uc?id=${fileId}&export=download`;
}
function folderLink(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
function formatBytes(bytes) {
  if (!bytes || bytes === '0') return 'Unknown';
  const b = parseInt(bytes);
  if (isNaN(b)) return 'Unknown';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return `${(b / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

// ── File operations ────────────────────────────────────────────────────────────
async function uploadToDrive(credentials, filePath, fileName, mimeType, folderId, onProgress) {
  const drive = getDriveClient(credentials);
  const fs = require('fs');
  const fileSize = fs.statSync(filePath).size;
  let uploaded = 0;
  let lastUpdate = Date.now();
  let lastBytes = 0;
  const startTime = Date.now();

  const body = fs.createReadStream(filePath);
  body.on('data', (chunk) => {
    uploaded += chunk.length;
    const now = Date.now();
    if (now - lastUpdate > 1500 && onProgress) {
      const elapsed = (now - lastUpdate) / 1000;
      const speed = (uploaded - lastBytes) / elapsed;
      const remaining = (fileSize - uploaded) / speed;
      const pct = Math.round((uploaded / fileSize) * 100);
      const filled = Math.round(pct / 5);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      onProgress({ pct, bar, speed, remaining, uploaded, fileSize });
      lastUpdate = now;
      lastBytes = uploaded;
    }
  });

  const file = await drive.files.create({
    resource: { name: fileName, parents: folderId ? [folderId] : [] },
    media: { mimeType, body },
    fields: 'id, name, size, mimeType, md5Checksum',
  });
  return file.data;
}

async function getFileInfo(credentials, fileId) {
  const drive = getDriveClient(credentials);
  const file = await drive.files.get({
    fileId,
    fields: 'id, name, size, mimeType, createdTime, modifiedTime, starred, trashed, md5Checksum, parents',
  });
  return file.data;
}

async function isFilePublic(credentials, fileId) {
  const drive = getDriveClient(credentials);
  const perms = await drive.permissions.list({ fileId, fields: 'permissions(type,role)' });
  return (perms.data.permissions || []).some(p => p.type === 'anyone' && p.role === 'reader');
}

async function setFilePublic(credentials, fileId, isPublic) {
  const drive = getDriveClient(credentials);
  if (isPublic) {
    await drive.permissions.create({ fileId, resource: { role: 'reader', type: 'anyone' } });
  } else {
    const perms = await drive.permissions.list({ fileId, fields: 'permissions(id,type)' });
    for (const perm of perms.data.permissions || []) {
      if (perm.type === 'anyone') await drive.permissions.delete({ fileId, permissionId: perm.id });
    }
  }
}

async function renameFile(credentials, fileId, newName) {
  const drive = getDriveClient(credentials);
  await drive.files.update({ fileId, resource: { name: newName } });
}

async function deleteFile(credentials, fileId) {
  const drive = getDriveClient(credentials);
  await drive.files.delete({ fileId });
}

async function trashFile(credentials, fileId) {
  const drive = getDriveClient(credentials);
  await drive.files.update({ fileId, resource: { trashed: true } });
}

async function starFile(credentials, fileId, starred) {
  const drive = getDriveClient(credentials);
  await drive.files.update({ fileId, resource: { starred } });
}

async function duplicateFile(credentials, fileId, name) {
  const drive = getDriveClient(credentials);
  const copy = await drive.files.copy({
    fileId,
    resource: { name: `Salinan dari ${name}` },
    fields: 'id, name',
  });
  return copy.data;
}

async function listFolders(credentials) {
  const drive = getDriveClient(credentials);
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
    fields: 'files(id, name)',
    pageSize: 20,
    orderBy: 'name',
  });
  return res.data.files || [];
}

async function listFolderContents(credentials, folderId) {
  const drive = getDriveClient(credentials);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, mimeType, size, modifiedTime)',
    pageSize: 50,
    orderBy: 'folder,name',
  });
  return res.data.files || [];
}

async function moveFile(credentials, fileId, newFolderId) {
  const drive = getDriveClient(credentials);
  const file = await drive.files.get({ fileId, fields: 'parents' });
  const previousParents = (file.data.parents || []).join(',');
  await drive.files.update({ fileId, addParents: newFolderId, removeParents: previousParents, fields: 'id' });
}

async function createFolder(credentials, name, parentId) {
  const drive = getDriveClient(credentials);
  const folder = await drive.files.create({
    resource: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : [],
    },
    fields: 'id, name',
  });
  return folder.data;
}

async function listFiles(credentials, options = {}) {
  const drive = getDriveClient(credentials);
  const { query, mimeFilter, minSize, maxSize, starred, pageToken, pageSize = 10, orderBy = 'modifiedTime desc' } = options;
  
  let q = "mimeType != 'application/vnd.google-apps.folder' and trashed=false";
  if (query) q += ` and name contains '${query.replace(/'/g, "\\'")}'`;
  if (mimeFilter) q += ` and mimeType contains '${mimeFilter}'`;
  if (starred) q += ` and starred=true`;

  const res = await drive.files.list({
    q,
    fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, starred, md5Checksum)',
    pageSize,
    orderBy,
    pageToken: pageToken || undefined,
  });

  let files = res.data.files || [];
  if (minSize) files = files.filter(f => parseInt(f.size) >= minSize);
  if (maxSize) files = files.filter(f => parseInt(f.size) <= maxSize);

  return { files, nextPageToken: res.data.nextPageToken };
}

async function getStorageQuota(credentials) {
  const drive = getDriveClient(credentials);
  const res = await drive.about.get({ fields: 'storageQuota' });
  return res.data.storageQuota;
}

async function findDuplicates(credentials, checksum, fileName, fileSize) {
  const drive = getDriveClient(credentials);
  // cek berdasarkan md5 atau nama+size
  const byHash = checksum ? await drive.files.list({
    q: `fullText contains '${checksum}' and trashed=false`,
    fields: 'files(id, name, size)',
    pageSize: 5,
  }) : { data: { files: [] } };

  const byName = await drive.files.list({
    q: `name='${fileName.replace(/'/g, "\\'")}' and trashed=false`,
    fields: 'files(id, name, size, md5Checksum)',
    pageSize: 5,
  });

  const dupes = [];
  for (const f of byName.data.files || []) {
    if (f.size === String(fileSize)) dupes.push(f);
  }
  return dupes;
}

// Auto-organize: tentukan folder berdasarkan tipe file
function getAutoFolder(mimeType, fileName) {
  if (mimeType.startsWith('image/')) return { name: '📷 Images', key: 'images' };
  if (mimeType.startsWith('video/')) return { name: '🎬 Videos', key: 'videos' };
  if (mimeType.startsWith('audio/')) return { name: '🎵 Audio', key: 'audio' };
  if (mimeType === 'application/pdf') return { name: '📄 Documents', key: 'documents' };
  if (mimeType.includes('spreadsheet') || fileName.endsWith('.xlsx') || fileName.endsWith('.csv')) return { name: '📊 Spreadsheets', key: 'spreadsheets' };
  if (mimeType.includes('presentation') || fileName.endsWith('.pptx')) return { name: '📑 Presentations', key: 'presentations' };
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('compressed')) return { name: '📦 Archives', key: 'archives' };
  if (mimeType.includes('text/') || fileName.endsWith('.txt') || fileName.endsWith('.md')) return { name: '📝 Text Files', key: 'text' };
  return { name: '📁 Others', key: 'others' };
}

async function ensureAutoFolder(credentials, mimeType, fileName) {
  const folderInfo = getAutoFolder(mimeType, fileName);
  const drive = getDriveClient(credentials);
  // cek apakah folder sudah ada
  const existing = await drive.files.list({
    q: `name='${folderInfo.name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  if (existing.data.files && existing.data.files.length > 0) {
    return existing.data.files[0].id;
  }
  // buat folder baru
  const folder = await createFolder(credentials, folderInfo.name, null);
  return folder.id;
}

module.exports = {
  shareLink, downloadLink, folderLink, formatBytes,
  uploadToDrive, getFileInfo, isFilePublic, setFilePublic,
  renameFile, deleteFile, trashFile, starFile, duplicateFile,
  listFolders, listFolderContents, moveFile, createFolder,
  listFiles, getStorageQuota, findDuplicates, getAutoFolder,
  ensureAutoFolder, getDriveClient,
};
