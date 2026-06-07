const { Markup } = require('telegraf');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const {
  getFileInfo, isFilePublic, setFilePublic, renameFile,
  deleteFile, trashFile, starFile, duplicateFile,
  listFolders, moveFile, listFolderContents,
  shareLink, downloadLink, folderLink, formatBytes, getDriveClient,
} = require('../lib/drive');
const { getUserCredentials } = require('../lib/users');
const { fileMenuButtons } = require('./upload');

function registerFileActions(bot, pendingActions) {

  // ── Salin link ─────────────────────────────────────────────────────────────
  bot.action(/^copy_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('🔗 Link file:\n' + shareLink(ctx.match[1]));
  });

  // ── Download link ──────────────────────────────────────────────────────────
  bot.action(/^dllink_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('📥 Link download langsung:\n' + downloadLink(ctx.match[1]));
  });

  // ── Toggle publik/privat ───────────────────────────────────────────────────
  bot.action(/^toggle_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    try {
      const pub = await isFilePublic(creds, fileId);
      await setFilePublic(creds, fileId, !pub);
      const newPub = !pub;
      await ctx.answerCbQuery(newPub ? '🌐 File sekarang Publik' : '🔒 File sekarang Privat');
      const info = await getFileInfo(creds, fileId);
      await ctx.editMessageText(
        '✅ Akses diperbarui!\n\n' +
        `📄 Nama: ${info.name}\n` +
        `🔗 Link: ${shareLink(fileId)}\n` +
        `👁️ Akses: ${newPub ? 'Publik 🌐' : 'Privat 🔒'}\n\n` +
        'Gunakan tombol di bawah untuk mengelola file:',
        fileMenuButtons(fileId, newPub, info.starred)
      );
    } catch (e) {
      await ctx.answerCbQuery('❌ Gagal mengubah akses');
    }
  });

  // ── Bintang ────────────────────────────────────────────────────────────────
  bot.action(/^star_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    try {
      const info = await getFileInfo(creds, fileId);
      const newStarred = !info.starred;
      await starFile(creds, fileId, newStarred);
      await ctx.answerCbQuery(newStarred ? '⭐ Dibintangi!' : '★ Bintang dihapus');
      const pub = await isFilePublic(creds, fileId);
      await ctx.editMessageText(
        `${newStarred ? '⭐' : '📄'} ${info.name}\n\n` +
        `🔗 Link: ${shareLink(fileId)}\n` +
        `⭐ Bintang: ${newStarred ? 'Ya' : 'Tidak'}\n\n` +
        'Gunakan tombol di bawah untuk mengelola file:',
        fileMenuButtons(fileId, pub, newStarred)
      );
    } catch (e) {
      await ctx.answerCbQuery('❌ Gagal');
    }
  });

  // ── Duplikat ───────────────────────────────────────────────────────────────
  bot.action(/^dup_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    try {
      const info = await getFileInfo(creds, fileId);
      await ctx.answerCbQuery('📋 Menduplikat...');
      const copy = await duplicateFile(creds, fileId, info.name);
      await ctx.reply(
        '📋 File berhasil diduplikat!\n\n' +
        `📄 Nama: ${copy.name}\n` +
        `🔗 Link: ${shareLink(copy.id)}`,
        fileMenuButtons(copy.id, false, false)
      );
    } catch (e) {
      await ctx.answerCbQuery('❌ Gagal menduplikat');
    }
  });

  // ── Info file ──────────────────────────────────────────────────────────────
  bot.action(/^info_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    try {
      const info = await getFileInfo(creds, fileId);
      const pub = await isFilePublic(creds, fileId);
      await ctx.answerCbQuery();
      await ctx.reply(
        'ℹ️ Info File\n\n' +
        `📄 Nama: ${info.name}\n` +
        `📦 Ukuran: ${formatBytes(info.size)}\n` +
        `🗂️ Tipe: ${info.mimeType}\n` +
        `👁️ Akses: ${pub ? 'Publik 🌐' : 'Privat 🔒'}\n` +
        `⭐ Bintang: ${info.starred ? 'Ya' : 'Tidak'}\n` +
        `📅 Dibuat: ${new Date(info.createdTime).toLocaleString('id-ID')}\n` +
        `✏️ Diubah: ${new Date(info.modifiedTime).toLocaleString('id-ID')}\n` +
        `🔗 Link View: ${shareLink(fileId)}\n` +
        `📥 Link Download: ${downloadLink(fileId)}`,
        fileMenuButtons(fileId, pub, info.starred)
      );
    } catch (e) {
      await ctx.answerCbQuery('❌ Gagal mengambil info');
    }
  });

  // ── Hapus permanen ─────────────────────────────────────────────────────────
  bot.action(/^delete_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.reply(
      '⚠️ Yakin hapus PERMANEN? Tidak bisa dikembalikan!',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ya, Hapus Permanen', `confirmdelete_${fileId}`), Markup.button.callback('❌ Batal', 'cancel')],
      ])
    );
  });
  bot.action(/^confirmdelete_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    try {
      await deleteFile(creds, fileId);
      await ctx.answerCbQuery('🗑️ Dihapus!');
      await ctx.editMessageText('🗑️ File dihapus permanen dari Google Drive.');
    } catch (e) {
      await ctx.answerCbQuery('❌ Gagal menghapus');
    }
  });

  // ── Pindah sampah ──────────────────────────────────────────────────────────
  bot.action(/^trash_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    try {
      await trashFile(creds, fileId);
      await ctx.answerCbQuery('🚮 Dipindah ke sampah');
      await ctx.editMessageText('🚮 File dipindahkan ke Sampah Drive. Bisa direstore dari Google Drive.');
    } catch (e) {
      await ctx.answerCbQuery('❌ Gagal');
    }
  });

  // ── Rename ─────────────────────────────────────────────────────────────────
  bot.action(/^rename_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    await ctx.answerCbQuery();
    pendingActions[ctx.from.id] = { action: 'rename', fileId };
    await ctx.reply(
      'Kirim nama baru untuk file ini (dengan ekstensinya, contoh: video_baru.mp4):',
      Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'cancel')]])
    );
  });

  // ── Pindah folder ──────────────────────────────────────────────────────────
  bot.action(/^move_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    await ctx.answerCbQuery();
    const creds = await getUserCredentials(ctx.from.id);
    try {
      const folders = await listFolders(creds);
      if (folders.length === 0) return ctx.reply('📁 Belum ada folder. Buat dengan /newfolder');
      const buttons = folders.map(f => [Markup.button.callback(`📁 ${f.name}`, `moveto_${fileId}_${f.id}`)]);
      buttons.push([Markup.button.callback('❌ Batal', 'cancel')]);
      await ctx.reply('📁 Pilih folder tujuan:', Markup.inlineKeyboard(buttons));
    } catch (e) {
      await ctx.reply('❌ Gagal: ' + e.message);
    }
  });
  bot.action(/^moveto_([^_]+)_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    const folderId = ctx.match[2];
    const creds = await getUserCredentials(ctx.from.id);
    try {
      await moveFile(creds, fileId, folderId);
      await ctx.answerCbQuery('✅ Dipindahkan!');
      await ctx.editMessageText('📁 File berhasil dipindahkan.');
    } catch (e) {
      await ctx.answerCbQuery('❌ Gagal memindahkan');
    }
  });

  // ── Browse folder ──────────────────────────────────────────────────────────
  bot.action(/^browsefolder_(.+)$/, async (ctx) => {
    const folderId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    try {
      await ctx.answerCbQuery();
      const items = await listFolderContents(creds, folderId);
      if (items.length === 0) {
        return ctx.editMessageText(
          '📂 Folder ini kosong.',
          Markup.inlineKeyboard([[Markup.button.callback('📤 Upload ke sini', `uploadhere_${folderId}`), Markup.button.callback('🔙 Kembali', 'browse_root')]])
        );
      }
      let msg = `📂 Isi folder (${items.length} item)\n\n`;
      const buttons = [];
      for (const item of items.slice(0, 15)) {
        const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
        const icon = isFolder ? '📁' : '📄';
        const size = isFolder ? '' : ` (${formatBytes(item.size)})`;
        msg += `${icon} ${item.name}${size}\n`;
        if (isFolder) {
          buttons.push([Markup.button.callback(`📁 ${item.name.substring(0, 25)}`, `browsefolder_${item.id}`)]);
        } else {
          buttons.push([Markup.button.callback(`📄 ${item.name.substring(0, 25)}`, `info_${item.id}`)]);
        }
      }
      buttons.push([Markup.button.callback('📤 Upload ke sini', `uploadhere_${folderId}`), Markup.button.callback('🔙 Root', 'browse_root')]);
      await ctx.editMessageText(msg, Markup.inlineKeyboard(buttons));
    } catch (e) {
      await ctx.answerCbQuery('❌ Gagal membuka folder');
    }
  });

  bot.action('browse_root', async (ctx) => {
    await ctx.answerCbQuery();
    const creds = await getUserCredentials(ctx.from.id);
    const folders = await listFolders(creds);
    if (folders.length === 0) return ctx.editMessageText('📂 Tidak ada folder di Drive kamu.');
    const buttons = folders.map(f => [Markup.button.callback(`📁 ${f.name}`, `browsefolder_${f.id}`)]);
    await ctx.editMessageText('📂 Pilih folder:', Markup.inlineKeyboard(buttons));
  });

  // Upload ke folder tertentu dari browse
  bot.action(/^uploadhere_(.+)$/, async (ctx) => {
    const folderId = ctx.match[1];
    await ctx.answerCbQuery();
    pendingActions[ctx.from.id] = { action: 'upload_to_folder', folderId };
    await ctx.reply(
      '📤 Kirim file yang ingin diupload ke folder ini.',
      Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'cancel')]])
    );
  });

  // ── Download semua file (zip) ───────────────────────────────────────────────
  bot.action(/^zipfolder_(.+)$/, async (ctx) => {
    const folderId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    await ctx.answerCbQuery();
    const statusMsg = await ctx.reply('📦 Menyiapkan ZIP... Ini mungkin butuh beberapa menit.');
    try {
      const items = await listFolderContents(creds, folderId);
      const files = items.filter(i => i.mimeType !== 'application/vnd.google-apps.folder');
      if (files.length === 0) return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Tidak ada file di folder ini.');
      if (files.length > 20) return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Maksimal 20 file per ZIP.');

      const zipPath = path.join(os.tmpdir(), `drivezip_${Date.now()}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.pipe(output);

      const tmpFiles = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
          `📦 Mengemas file ${i + 1}/${files.length}...\n${f.name}`
        );
        const tmpFile = path.join(os.tmpdir(), `zipitem_${Date.now()}_${i}`);
        const dlUrl = downloadLink(f.id);
        try {
          await dlFromUrl(dlUrl + '&confirm=1', tmpFile, null);
          archive.file(tmpFile, { name: f.name });
          tmpFiles.push(tmpFile);
        } catch (_) {}
      }

      await new Promise((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);
        archive.finalize();
      });

      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '📤 Mengirim ZIP...');
      await ctx.replyWithDocument({ source: zipPath, filename: `drive_files_${Date.now()}.zip` });
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);

      fs.unlinkSync(zipPath);
      tmpFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
    } catch (err) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Gagal membuat ZIP: ' + err.message);
    }
  });

  // ── Cancel ─────────────────────────────────────────────────────────────────
  bot.action('cancel', async (ctx) => {
    delete pendingActions[ctx.from.id];
    await ctx.answerCbQuery('Dibatalkan');
    try { await ctx.editMessageText('❌ Aksi dibatalkan.'); } catch (_) {}
  });
}

module.exports = { registerFileActions };
