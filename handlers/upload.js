const { Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const crypto = require('crypto');
const {
  uploadToDrive, getFileInfo, isFilePublic, ensureAutoFolder,
  shareLink, downloadLink, formatBytes, getAutoFolder,
} = require('../lib/drive');
const { getUserCredentials, saveUpload, checkDuplicateInHistory } = require('../lib/users');
const { enqueue } = require('../lib/queue');

function fileMenuButtons(fileId, isPublic, isStarred = false) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔗 Link View', `copy_${fileId}`),
      Markup.button.callback('📥 Link Download', `dllink_${fileId}`),
    ],
    [
      Markup.button.callback(isPublic ? '🔒 Jadikan Privat' : '🌐 Jadikan Publik', `toggle_${fileId}`),
      Markup.button.callback(isStarred ? '★ Hapus Bintang' : '⭐ Bintangi', `star_${fileId}`),
    ],
    [
      Markup.button.callback('✏️ Rename', `rename_${fileId}`),
      Markup.button.callback('📋 Duplikat', `dup_${fileId}`),
    ],
    [
      Markup.button.callback('📁 Pindah Folder', `move_${fileId}`),
      Markup.button.callback('ℹ️ Info File', `info_${fileId}`),
    ],
    [
      Markup.button.callback('🗑️ Hapus Permanen', `delete_${fileId}`),
      Markup.button.callback('🚮 Pindah Sampah', `trash_${fileId}`),
    ],
  ]);
}

async function computeChecksum(filePath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

async function dlFromUrl(url, destPath, onProgress) {
  const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 120000 });
  const total = parseInt(response.headers['content-length'] || '0');
  let downloaded = 0;
  let lastUpdate = Date.now();
  let lastBytes = 0;

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastUpdate > 1500 && onProgress && total > 0) {
        const elapsed = (now - lastUpdate) / 1000;
        const speed = (downloaded - lastBytes) / elapsed;
        const remaining = speed > 0 ? (total - downloaded) / speed : 0;
        const pct = Math.round((downloaded / total) * 100);
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        onProgress({ pct, bar, speed, remaining, downloaded, total });
        lastUpdate = now;
        lastBytes = downloaded;
      }
    });
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function formatSpeed(bps) {
  if (bps > 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps > 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}
function formatETA(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '...';
  if (seconds < 60) return `${Math.round(seconds)}d`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}d`;
}

async function handleMedia(ctx, fileId, fileName, mimeType, chosenFolderId) {
  const creds = await getUserCredentials(ctx.from.id);
  const statusMsg = await ctx.reply('⏳ Memproses file...');
  const tmpPath = path.join(os.tmpdir(), `${Date.now()}_${fileName}`);

  const doUpload = async () => {
    try {
      // Download dari Telegram
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '⬇️ Mengunduh dari Telegram...');
      const fileLink = await ctx.telegram.getFileLink(fileId);
      await dlFromUrl(fileLink.href, tmpPath, null);

      // Checksum
      const checksum = await computeChecksum(tmpPath);
      const fileSize = fs.statSync(tmpPath).size;

      // Duplicate check
      const dup = await checkDuplicateInHistory(ctx.from.id, checksum, fileName, fileSize);
      if (dup) {
        fs.unlinkSync(tmpPath);
        return ctx.telegram.editMessageText(
          ctx.chat.id, statusMsg.message_id, null,
          '⚠️ File duplikat terdeteksi!\n\n' +
          `📄 Nama: ${dup.fileName}\n` +
          `📅 Upload sebelumnya: ${new Date(dup.uploadedAt).toLocaleString('id-ID')}\n` +
          `🔗 Link: ${shareLink(dup.driveFileId)}\n\n` +
          'File tidak diupload ulang untuk menghemat storage.',
          Markup.inlineKeyboard([[Markup.button.callback('📤 Upload Tetap', `forceupload_${fileId}`), Markup.button.callback('❌ Batal', 'cancel')]])
        );
      }

      // Tentukan folder
      let targetFolderId = chosenFolderId || creds.defaultFolderId || null;
      let autoOrgMsg = '';
      if (!chosenFolderId && creds.autoOrganize) {
        targetFolderId = await ensureAutoFolder(creds, mimeType, fileName);
        const folderInfo = getAutoFolder(mimeType, fileName);
        autoOrgMsg = `\n📂 Auto: ${folderInfo.name}`;
      }

      // Upload ke Drive dengan progress
      let lastEditTime = 0;
      const driveFile = await uploadToDrive(creds, tmpPath, fileName, mimeType, targetFolderId, async ({ pct, bar, speed, remaining }) => {
        const now = Date.now();
        if (now - lastEditTime < 2000) return;
        lastEditTime = now;
        try {
          await ctx.telegram.editMessageText(
            ctx.chat.id, statusMsg.message_id, null,
            `☁️ Mengupload ke Google Drive...\n\n` +
            `[${bar}] ${pct}%\n` +
            `⚡ ${formatSpeed(speed)}\n` +
            `⏱️ ETA: ${formatETA(remaining)}`
          );
        } catch (_) {}
      });

      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

      const pub = await isFilePublic(creds, driveFile.id);
      const info = await getFileInfo(creds, driveFile.id);
      const category = getAutoFolder(mimeType, fileName).key;

      // Simpan ke history
      await saveUpload(ctx.from.id, {
        driveFileId: driveFile.id,
        fileName,
        mimeType,
        size: String(fileSize),
        checksum,
        category,
        folderId: targetFolderId,
        link: shareLink(driveFile.id),
      });

      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        '✅ Upload berhasil!\n\n' +
        `📄 Nama: ${driveFile.name}\n` +
        `📦 Ukuran: ${formatBytes(driveFile.size)}\n` +
        `🔗 Link: ${shareLink(driveFile.id)}\n` +
        `👁️ Akses: ${pub ? 'Publik 🌐' : 'Privat 🔒'}` +
        autoOrgMsg + '\n\n' +
        'Gunakan tombol di bawah untuk mengelola file:',
        fileMenuButtons(driveFile.id, pub, info.starred)
      );
    } catch (err) {
      console.error(err);
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Gagal upload: ' + err.message);
    }
  };

  await enqueue(ctx.from.id, doUpload);
}

// Upload dari URL
async function handleUrlUpload(ctx, url, chosenFolderId) {
  const creds = await getUserCredentials(ctx.from.id);
  const statusMsg = await ctx.reply('🔍 Menganalisis URL...');
  const tmpPath = path.join(os.tmpdir(), `url_${Date.now()}`);

  try {
    // Head request untuk nama & tipe
    let fileName = url.split('/').pop().split('?')[0] || `file_${Date.now()}`;
    let mimeType = 'application/octet-stream';
    try {
      const head = await axios.head(url, { timeout: 10000 });
      const ct = head.headers['content-type'] || '';
      mimeType = ct.split(';')[0].trim() || mimeType;
      const cd = head.headers['content-disposition'] || '';
      const match = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (match) fileName = match[1].replace(/['"]/g, '');
    } catch (_) {}

    if (!fileName.includes('.')) {
      const ext = mimeType.split('/')[1] || 'bin';
      fileName = `download_${Date.now()}.${ext}`;
    }

    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
      `⬇️ Mengunduh: ${fileName}\n\n[░░░░░░░░░░░░░░░░░░░░] 0%`
    );

    // Download
    let lastEditTime = 0;
    await dlFromUrl(url, tmpPath, async ({ pct, bar, speed, remaining, downloaded, total }) => {
      const now = Date.now();
      if (now - lastEditTime < 2000) return;
      lastEditTime = now;
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          `⬇️ Mengunduh: ${fileName}\n\n` +
          `[${bar}] ${pct}%\n` +
          `📦 ${formatBytes(downloaded)} / ${formatBytes(total)}\n` +
          `⚡ ${formatSpeed(speed)} | ⏱️ ETA: ${formatETA(remaining)}`
        );
      } catch (_) {}
    });

    const fileSize = fs.statSync(tmpPath).size;
    const checksum = await computeChecksum(tmpPath);

    // Duplicate check
    const dup = await checkDuplicateInHistory(ctx.from.id, checksum, fileName, fileSize);
    if (dup) {
      fs.unlinkSync(tmpPath);
      return ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        '⚠️ File duplikat terdeteksi!\n\n' +
        `📄 Nama: ${dup.fileName}\n` +
        `🔗 Link: ${shareLink(dup.driveFileId)}`
      );
    }

    // Tentukan folder
    let targetFolderId = chosenFolderId || creds.defaultFolderId || null;
    let autoOrgMsg = '';
    if (!chosenFolderId && creds.autoOrganize) {
      targetFolderId = await ensureAutoFolder(creds, mimeType, fileName);
      const folderInfo = getAutoFolder(mimeType, fileName);
      autoOrgMsg = `\n📂 Auto: ${folderInfo.name}`;
    }

    // Upload ke Drive
    lastEditTime = 0;
    const driveFile = await uploadToDrive(creds, tmpPath, fileName, mimeType, targetFolderId, async ({ pct, bar, speed, remaining }) => {
      const now = Date.now();
      if (now - lastEditTime < 2000) return;
      lastEditTime = now;
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          `☁️ Mengupload ke Drive...\n\n[${bar}] ${pct}%\n⚡ ${formatSpeed(speed)}\n⏱️ ETA: ${formatETA(remaining)}`
        );
      } catch (_) {}
    });

    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);

    const pub = await isFilePublic(creds, driveFile.id);
    const info = await getFileInfo(creds, driveFile.id);
    const category = getAutoFolder(mimeType, fileName).key;

    await saveUpload(ctx.from.id, {
      driveFileId: driveFile.id,
      fileName,
      mimeType,
      size: String(fileSize),
      checksum,
      category,
      folderId: targetFolderId,
      link: shareLink(driveFile.id),
      source: 'url',
      sourceUrl: url,
    });

    await ctx.telegram.editMessageText(
      ctx.chat.id, statusMsg.message_id, null,
      '✅ Upload dari URL berhasil!\n\n' +
      `📄 Nama: ${driveFile.name}\n` +
      `📦 Ukuran: ${formatBytes(driveFile.size)}\n` +
      `🔗 Link: ${shareLink(driveFile.id)}\n` +
      `👁️ Akses: ${pub ? 'Publik 🌐' : 'Privat 🔒'}` +
      autoOrgMsg + '\n\n' +
      'Gunakan tombol di bawah untuk mengelola file:',
      fileMenuButtons(driveFile.id, pub, info.starred)
    );
  } catch (err) {
    console.error(err);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Gagal upload dari URL: ' + err.message);
  }
}

module.exports = { handleMedia, handleUrlUpload, fileMenuButtons };
