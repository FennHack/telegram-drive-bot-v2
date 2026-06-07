const { Markup } = require('telegraf');
const {
  listFiles, listFolders, listFolderContents, createFolder,
  getStorageQuota, formatBytes, shareLink, folderLink,
} = require('../lib/drive');
const { getUserCredentials, getUploadHistory, getUploadStats } = require('../lib/users');

function registerCommands(bot, pendingActions) {

  // ── /start ─────────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const { isSetup } = require('../lib/users');
    const setup = await isSetup(ctx.from.id);
    if (!setup) {
      return ctx.reply(
        `👋 Halo ${ctx.from.first_name}! Selamat datang di Drive Bot!\n\n` +
        '🔐 Untuk mulai, kamu perlu login dengan akun Google Drive kamu.\n\n' +
        'Ketik /setup untuk memulai proses login.\n\n' +
        'Bot ini aman — credentials kamu tersimpan terenkripsi dan hanya bisa diakses oleh kamu.',
        Markup.inlineKeyboard([[Markup.button.callback('🔐 Mulai Setup', 'start_setup')]])
      );
    }
    ctx.reply(
      `👋 Halo ${ctx.from.first_name}! Drive Bot siap digunakan.\n\n` +
      '📤 Kirim foto/video/file untuk upload ke Drive\n\n' +
      'Perintah:\n' +
      '/drive - Lihat file di Drive\n' +
      '/browse - Browse folder\n' +
      '/uploadurl - Upload dari URL\n' +
      '/cari - Cari file\n' +
      '/storage - Info penyimpanan\n' +
      '/riwayat - Riwayat upload\n' +
      '/statistik - Statistik upload\n' +
      '/newfolder - Buat folder baru\n' +
      '/myaccount - Pengaturan akun\n' +
      '/help - Bantuan lengkap'
    );
  });

  bot.action('start_setup', async (ctx) => {
    await ctx.answerCbQuery();
    const { registerSetup } = require('./setup');
    // trigger setup flow
    ctx.message = { text: '/setup' };
    ctx.from = ctx.from;
    // manual trigger
    const { saveUser } = require('../lib/users');
    const { setupState } = require('./setup');
    ctx.reply(
      '🔐 Setup Google Drive Bot\n\n' +
      'Saya akan memandu kamu.\n\n' +
      'Pertama, kirimkan Client ID Google OAuth2 kamu\n' +
      '(format: xxx.apps.googleusercontent.com):'
    );
  });

  // ── /help ──────────────────────────────────────────────────────────────────
  bot.command('help', (ctx) => {
    ctx.reply(
      '📖 Bantuan Drive Bot\n\n' +
      '📤 UPLOAD FILE\n' +
      '• Kirim foto/video/dokumen langsung\n' +
      '• /uploadurl [url] - upload dari link internet\n' +
      '• /browse - pilih folder lalu upload ke sana\n\n' +
      '📂 KELOLA FILE\n' +
      '• /drive - 10 file terbaru\n' +
      '• /browse - browse folder\n' +
      '• /cari [kata] - cari file\n' +
      '• /bintang - file berbintang\n\n' +
      '📊 INFO\n' +
      '• /storage - info penyimpanan\n' +
      '• /riwayat - histori upload\n' +
      '• /statistik - statistik upload\n\n' +
      '⚙️ PENGATURAN\n' +
      '• /myaccount - profil & pengaturan\n' +
      '• /newfolder [nama] - buat folder\n' +
      '• /setup - login/ganti akun\n' +
      '• /logout - hapus akun\n\n' +
      '🔧 TOMBOL FILE\n' +
      '🔗 Link View | 📥 Link Download\n' +
      '🌐/🔒 Publik/Privat | ⭐ Bintang\n' +
      '✏️ Rename | 📋 Duplikat\n' +
      '📁 Pindah | ℹ️ Info\n' +
      '🗑️ Hapus | 🚮 Sampah'
    );
  });

  // ── /storage ───────────────────────────────────────────────────────────────
  bot.command('storage', async (ctx) => {
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup. Ketik /setup');
    try {
      const quota = await getStorageQuota(creds);
      const used = parseInt(quota.usage || 0);
      const total = parseInt(quota.limit || 0);
      const inDrive = parseInt(quota.usageInDrive || 0);
      const inTrash = parseInt(quota.usageInDriveTrash || 0);
      const pct = total > 0 ? ((used / total) * 100).toFixed(1) : '?';
      const filled = total > 0 ? Math.round(used / total * 20) : 0;
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      const sisa = total - used;
      const alertLevel = pct >= 90 ? '🚨' : pct >= 75 ? '⚠️' : '✅';
      await ctx.reply(
        '📊 Storage Google Drive\n\n' +
        `[${bar}] ${pct}%  ${alertLevel}\n\n` +
        `📦 Total: ${formatBytes(total)}\n` +
        `🔴 Terpakai: ${formatBytes(used)}\n` +
        `📂 Di Drive: ${formatBytes(inDrive)}\n` +
        `🗑️ Di Sampah: ${formatBytes(inTrash)}\n` +
        `✅ Sisa: ${formatBytes(sisa)}\n\n` +
        (pct >= 90 ? '🚨 Storage hampir penuh! Segera kosongkan sampah atau hapus file.' :
         pct >= 75 ? '⚠️ Storage sudah 75%, mulai pertimbangkan untuk cleanup.' : 
         '✅ Storage masih aman.')
      );
    } catch (e) {
      ctx.reply('❌ Gagal: ' + e.message);
    }
  });

  // ── /drive ─────────────────────────────────────────────────────────────────
  bot.command('drive', async (ctx) => {
    await showFileList(ctx, {});
  });

  async function showFileList(ctx, options, editMsg = false) {
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup. Ketik /setup');
    try {
      const { files, nextPageToken } = await listFiles(creds, { pageSize: 8, ...options });
      if (files.length === 0) {
        const msg = '📂 Tidak ada file ditemukan.';
        return editMsg ? ctx.editMessageText(msg) : ctx.reply(msg);
      }
      let msg = `📂 File di Drive ${options.query ? `(cari: "${options.query}")` : '(terbaru)'}\n\n`;
      const buttons = [];
      files.forEach((f, i) => {
        const icon = f.mimeType.startsWith('image/') ? '🖼️' :
          f.mimeType.startsWith('video/') ? '🎬' :
          f.mimeType.startsWith('audio/') ? '🎵' :
          f.mimeType === 'application/pdf' ? '📄' : '📁';
        msg += `${i + 1}. ${icon} ${f.name}\n   ${formatBytes(f.size)} • ${new Date(f.modifiedTime).toLocaleDateString('id-ID')}${f.starred ? ' ⭐' : ''}\n`;
        buttons.push([Markup.button.callback(`${icon} ${f.name.substring(0, 28)}`, `info_${f.id}`)]);
      });

      const navButtons = [];
      if (options.pageToken) navButtons.push(Markup.button.callback('⬅️ Prev', `prevpage_${JSON.stringify(options)}`));
      if (nextPageToken) navButtons.push(Markup.button.callback('➡️ Next', `nextpage_${nextPageToken}`));
      if (navButtons.length) buttons.push(navButtons);
      buttons.push([Markup.button.callback('🔍 Filter/Cari', 'filter_menu'), Markup.button.callback('🔄 Refresh', 'refresh_drive')]);

      const markup = Markup.inlineKeyboard(buttons);
      if (editMsg) {
        await ctx.editMessageText(msg, markup);
      } else {
        await ctx.reply(msg, markup);
      }
    } catch (e) {
      ctx.reply('❌ Gagal: ' + e.message);
    }
  }

  bot.action('refresh_drive', async (ctx) => {
    await ctx.answerCbQuery('🔄 Refresh...');
    await showFileList(ctx, {}, true);
  });

  bot.action(/^nextpage_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showFileList(ctx, { pageToken: ctx.match[1] }, true);
  });

  bot.action('filter_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '🔍 Filter File:',
      Markup.inlineKeyboard([
        [Markup.button.callback('🖼️ Gambar', 'filter_image'), Markup.button.callback('🎬 Video', 'filter_video')],
        [Markup.button.callback('🎵 Audio', 'filter_audio'), Markup.button.callback('📄 PDF', 'filter_pdf')],
        [Markup.button.callback('⭐ Berbintang', 'filter_starred'), Markup.button.callback('📅 Terlama', 'filter_oldest')],
        [Markup.button.callback('🔍 Cari by Nama', 'search_prompt'), Markup.button.callback('🔙 Kembali', 'refresh_drive')],
      ])
    );
  });

  bot.action('filter_image', async (ctx) => { await ctx.answerCbQuery(); await showFileList(ctx, { mimeFilter: 'image/' }, true); });
  bot.action('filter_video', async (ctx) => { await ctx.answerCbQuery(); await showFileList(ctx, { mimeFilter: 'video/' }, true); });
  bot.action('filter_audio', async (ctx) => { await ctx.answerCbQuery(); await showFileList(ctx, { mimeFilter: 'audio/' }, true); });
  bot.action('filter_pdf', async (ctx) => { await ctx.answerCbQuery(); await showFileList(ctx, { mimeFilter: 'application/pdf' }, true); });
  bot.action('filter_starred', async (ctx) => { await ctx.answerCbQuery(); await showFileList(ctx, { starred: true }, true); });
  bot.action('filter_oldest', async (ctx) => { await ctx.answerCbQuery(); await showFileList(ctx, { orderBy: 'modifiedTime' }, true); });

  bot.action('search_prompt', async (ctx) => {
    await ctx.answerCbQuery();
    pendingActions[ctx.from.id] = { action: 'search' };
    await ctx.reply('🔍 Ketik kata kunci pencarian:\nContoh: foto, video 2024, laporan');
  });

  // ── /cari ──────────────────────────────────────────────────────────────────
  bot.command('cari', async (ctx) => {
    const query = ctx.message.text.replace('/cari', '').trim();
    if (!query) {
      pendingActions[ctx.from.id] = { action: 'search' };
      return ctx.reply('🔍 Ketik kata kunci:\nContoh: /cari foto liburan\n\nAtau ketik saja setelah ini:');
    }
    await showFileList(ctx, { query });
  });

  // ── /bintang ───────────────────────────────────────────────────────────────
  bot.command('bintang', async (ctx) => {
    await showFileList(ctx, { starred: true });
  });

  // ── /browse ────────────────────────────────────────────────────────────────
  bot.command('browse', async (ctx) => {
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup. Ketik /setup');
    try {
      const folders = await listFolders(creds);
      if (folders.length === 0) {
        return ctx.reply('📂 Belum ada folder. Buat dengan /newfolder', Markup.inlineKeyboard([
          [Markup.button.callback('📤 Upload ke Root Drive', 'uploadhere_root')]
        ]));
      }
      const buttons = folders.map(f => [
        Markup.button.callback(`📁 ${f.name}`, `browsefolder_${f.id}`)
      ]);
      buttons.push([Markup.button.callback('📤 Upload ke Root', 'uploadhere_root')]);
      await ctx.reply('📂 Pilih folder untuk browse atau upload:', Markup.inlineKeyboard(buttons));
    } catch (e) {
      ctx.reply('❌ Gagal: ' + e.message);
    }
  });

  // ── /uploadurl ─────────────────────────────────────────────────────────────
  bot.command('uploadurl', async (ctx) => {
    const url = ctx.message.text.replace('/uploadurl', '').trim();
    if (!url || !url.startsWith('http')) {
      pendingActions[ctx.from.id] = { action: 'uploadurl' };
      return ctx.reply(
        '🌐 Upload dari URL\n\n' +
        'Kirimkan URL file yang ingin didownload dan diupload ke Drive.\n\n' +
        'Contoh:\nhttps://example.com/video.mp4\nhttps://example.com/foto.jpg\n\n' +
        'Atau langsung: /uploadurl https://example.com/file.mp4',
        Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'cancel')]])
      );
    }
    const { handleUrlUpload } = require('./upload');
    await handleUrlUpload(ctx, url, null);
  });

  // ── /newfolder ─────────────────────────────────────────────────────────────
  bot.command('newfolder', async (ctx) => {
    const name = ctx.message.text.replace('/newfolder', '').trim();
    if (!name) {
      pendingActions[ctx.from.id] = { action: 'newfolder' };
      return ctx.reply('🗂️ Ketik nama folder yang ingin dibuat:');
    }
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup. Ketik /setup');
    try {
      const folder = await createFolder(creds, name, null);
      await ctx.reply(
        '✅ Folder berhasil dibuat!\n\n' +
        `🗂️ Nama: ${folder.name}\n` +
        `🔗 Link: ${folderLink(folder.id)}`,
        Markup.inlineKeyboard([[Markup.button.callback('📤 Upload ke folder ini', `uploadhere_${folder.id}`)]])
      );
    } catch (e) {
      ctx.reply('❌ Gagal: ' + e.message);
    }
  });

  // ── /riwayat ───────────────────────────────────────────────────────────────
  bot.command('riwayat', async (ctx) => {
    await showHistory(ctx, 0);
  });

  async function showHistory(ctx, page, editMsg = false) {
    const { items, total, pages } = await getUploadHistory(ctx.from.id, page, 5);
    if (items.length === 0) {
      const msg = '📋 Belum ada riwayat upload.';
      return editMsg ? ctx.editMessageText(msg) : ctx.reply(msg);
    }
    let msg = `📋 Riwayat Upload (${page * 5 + 1}-${Math.min((page + 1) * 5, total)} dari ${total})\n\n`;
    items.forEach((item, i) => {
      const icon = item.mimeType?.startsWith('image/') ? '🖼️' :
        item.mimeType?.startsWith('video/') ? '🎬' : '📄';
      msg += `${icon} ${item.fileName}\n`;
      msg += `   📦 ${formatBytes(item.size)} • ${new Date(item.uploadedAt).toLocaleString('id-ID')}\n`;
      msg += `   🔗 ${shareLink(item.driveFileId)}\n\n`;
    });

    const navButtons = [];
    if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `history_${page - 1}`));
    if (page < pages - 1) navButtons.push(Markup.button.callback('➡️ Next', `history_${page + 1}`));

    const buttons = [];
    if (navButtons.length) buttons.push(navButtons);
    buttons.push([Markup.button.callback('📊 Statistik', 'show_stats')]);

    const markup = Markup.inlineKeyboard(buttons);
    if (editMsg) await ctx.editMessageText(msg, markup);
    else await ctx.reply(msg, markup);
  }

  bot.action(/^history_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await showHistory(ctx, parseInt(ctx.match[1]), true);
  });

  // ── /statistik ─────────────────────────────────────────────────────────────
  bot.command('statistik', async (ctx) => {
    await showStats(ctx);
  });

  bot.action('show_stats', async (ctx) => {
    await ctx.answerCbQuery();
    await showStats(ctx);
  });

  async function showStats(ctx) {
    const { getUploadStats } = require('../lib/users');
    const stats = await getUploadStats(ctx.from.id);
    let msg = `📊 Statistik Upload\n\n`;
    msg += `📁 Total upload: ${stats.total} file\n`;
    msg += `💾 Total ukuran: ${formatBytes(stats.totalSize)}\n\n`;
    msg += `Breakdown per kategori:\n`;
    for (const t of stats.byType) {
      const icons = { images: '🖼️', videos: '🎬', audio: '🎵', documents: '📄', others: '📁' };
      const icon = icons[t._id] || '📁';
      msg += `${icon} ${t._id}: ${t.count} file (${formatBytes(t.totalSize)})\n`;
    }
    await ctx.reply(msg);
  }

  // ── /logout ────────────────────────────────────────────────────────────────
  bot.command('logout', async (ctx) => {
    await ctx.reply(
      '⚠️ Yakin ingin logout? Credentials Drive kamu akan dihapus dari bot.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ya, Logout', 'confirm_logout')],
        [Markup.button.callback('❌ Batal', 'cancel')],
      ])
    );
  });
}

module.exports = { registerCommands };
