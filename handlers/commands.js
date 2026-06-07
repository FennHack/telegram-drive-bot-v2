const { Markup } = require('telegraf');
const {
  listFiles, listFolders, listFolderContents, createFolder,
  getStorageQuota, formatBytes, shareLink, folderLink,
  downloadDriveItem,
} = require('../lib/drive');
const { getUserCredentials, getUploadHistory, getUploadStats } = require('../lib/users');

// ── Session pagination (in-memory, cukup untuk single instance) ────────────────
// key: `${userId}_page` → { options, history: [token,...] }
const pageSession = {};

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
      '/drive — Lihat file di Drive\n' +
      '/browse — Browse folder\n' +
      '/download — Download file/folder dari Drive\n' +
      '/uploadto — Upload ke folder Drive tertentu\n' +
      '/cari — Cari file\n' +
      '/storage — Info penyimpanan\n' +
      '/riwayat — Riwayat upload\n' +
      '/statistik — Statistik upload\n' +
      '/newfolder — Buat folder baru\n' +
      '/myaccount — Pengaturan akun\n' +
      '/help — Bantuan lengkap'
    );
  });

  bot.action('start_setup', async (ctx) => {
    await ctx.answerCbQuery();
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
      '• /uploadurl [url] — upload dari link internet\n' +
      '• /uploadto [link folder] — upload ke folder Drive tertentu\n' +
      '• /browse — pilih folder lalu upload ke sana\n\n' +
      '📂 KELOLA FILE\n' +
      '• /drive — 10 file terbaru\n' +
      '• /browse — browse folder\n' +
      '• /cari [kata] — cari file\n' +
      '• /bintang — file berbintang\n' +
      '• /download [link drive] — download file/folder dari Drive\n\n' +
      '📊 INFO\n' +
      '• /storage — info penyimpanan\n' +
      '• /riwayat — histori upload\n' +
      '• /statistik — statistik upload\n\n' +
      '⚙️ PENGATURAN\n' +
      '• /myaccount — profil & pengaturan\n' +
      '• /newfolder [nama] — buat folder\n' +
      '• /setup — login/ganti akun\n' +
      '• /logout — hapus akun\n\n' +
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
    // reset session
    pageSession[ctx.from.id] = { options: {}, tokenHistory: [null] };
    await showFileList(ctx, {}, 0, false);
  });

  /**
   * Render daftar file.
   * @param {object} ctx
   * @param {object} options  - filter options untuk listFiles
   * @param {number} page     - indeks halaman saat ini (0-based)
   * @param {boolean} editMsg - edit pesan existing atau kirim baru
   */
  async function showFileList(ctx, options, page, editMsg) {
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup. Ketik /setup');

    const session = pageSession[ctx.from.id] || { options, tokenHistory: [null] };
    const pageToken = session.tokenHistory[page] || undefined;

    try {
      const { files, nextPageToken } = await listFiles(creds, { pageSize: 8, ...options, pageToken });

      // Simpan token halaman berikutnya
      if (nextPageToken && session.tokenHistory.length === page + 1) {
        session.tokenHistory.push(nextPageToken);
      }
      pageSession[ctx.from.id] = session;

      if (files.length === 0) {
        const msg = '📂 Tidak ada file ditemukan.';
        return editMsg ? ctx.editMessageText(msg) : ctx.reply(msg);
      }

      let msg = `📂 File di Drive ${options.query ? `— 🔍 "${options.query}"` : '— terbaru'} (hal. ${page + 1})\n\n`;
      const fileButtons = [];
      files.forEach((f, i) => {
        const icon =
          f.mimeType.startsWith('image/') ? '🖼' :
          f.mimeType.startsWith('video/') ? '🎬' :
          f.mimeType.startsWith('audio/') ? '🎵' :
          f.mimeType === 'application/pdf' ? '📄' : '📁';
        msg += `${i + 1}. ${icon} ${f.name}\n   ${formatBytes(f.size)} • ${new Date(f.modifiedTime).toLocaleDateString('id-ID')}${f.starred ? ' ⭐' : ''}\n`;
        fileButtons.push([Markup.button.callback(`${icon} ${f.name.substring(0, 28)}`, `info_${f.id}`)]);
      });

      // Navigasi — hanya pakai nomor halaman, bukan token langsung (aman untuk 64b limit)
      const navButtons = [];
      if (page > 0) navButtons.push(Markup.button.callback('⬅️ Prev', `drivepage_${page - 1}`));
      if (nextPageToken) navButtons.push(Markup.button.callback('➡️ Next', `drivepage_${page + 1}`));
      if (navButtons.length) fileButtons.push(navButtons);

      fileButtons.push([
        Markup.button.callback('🔍 Filter/Cari', 'filter_menu'),
        Markup.button.callback('🔄 Refresh', 'refresh_drive'),
      ]);

      const markup = Markup.inlineKeyboard(fileButtons);
      if (editMsg) {
        await ctx.editMessageText(msg, markup);
      } else {
        await ctx.reply(msg, markup);
      }
    } catch (e) {
      const errMsg = '❌ Gagal memuat file: ' + e.message;
      try {
        editMsg ? await ctx.editMessageText(errMsg) : await ctx.reply(errMsg);
      } catch (_) {
        await ctx.reply(errMsg);
      }
    }
  }

  // Navigasi halaman — ambil page index dari callback data
  bot.action(/^drivepage_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const page = parseInt(ctx.match[1]);
    const session = pageSession[ctx.from.id];
    if (!session) return ctx.reply('⚠️ Session habis. Ketik /drive lagi.');
    await showFileList(ctx, session.options, page, true);
  });

  bot.action('refresh_drive', async (ctx) => {
    await ctx.answerCbQuery('🔄 Refresh...');
    const session = pageSession[ctx.from.id] || { options: {}, tokenHistory: [null] };
    // reset ke halaman 1
    const freshSession = { options: session.options, tokenHistory: [null] };
    pageSession[ctx.from.id] = freshSession;
    await showFileList(ctx, session.options, 0, true);
  });

  bot.action('filter_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '🔍 Filter File:',
      Markup.inlineKeyboard([
        [Markup.button.callback('🖼 Gambar', 'filter_image'), Markup.button.callback('🎬 Video', 'filter_video')],
        [Markup.button.callback('🎵 Audio', 'filter_audio'), Markup.button.callback('📄 PDF', 'filter_pdf')],
        [Markup.button.callback('⭐ Berbintang', 'filter_starred'), Markup.button.callback('📅 Terlama', 'filter_oldest')],
        [Markup.button.callback('🔍 Cari by Nama', 'search_prompt'), Markup.button.callback('🔙 Kembali', 'refresh_drive')],
      ])
    );
  });

  async function applyFilter(ctx, options) {
    pageSession[ctx.from.id] = { options, tokenHistory: [null] };
    await showFileList(ctx, options, 0, true);
  }

  bot.action('filter_image',   async (ctx) => { await ctx.answerCbQuery(); await applyFilter(ctx, { mimeFilter: 'image/' }); });
  bot.action('filter_video',   async (ctx) => { await ctx.answerCbQuery(); await applyFilter(ctx, { mimeFilter: 'video/' }); });
  bot.action('filter_audio',   async (ctx) => { await ctx.answerCbQuery(); await applyFilter(ctx, { mimeFilter: 'audio/' }); });
  bot.action('filter_pdf',     async (ctx) => { await ctx.answerCbQuery(); await applyFilter(ctx, { mimeFilter: 'application/pdf' }); });
  bot.action('filter_starred', async (ctx) => { await ctx.answerCbQuery(); await applyFilter(ctx, { starred: true }); });
  bot.action('filter_oldest',  async (ctx) => { await ctx.answerCbQuery(); await applyFilter(ctx, { orderBy: 'modifiedTime' }); });

  bot.action('search_prompt', async (ctx) => {
    await ctx.answerCbQuery();
    pendingActions[ctx.from.id] = { action: 'search' };
    await ctx.reply('🔍 Ketik kata kunci pencarian:');
  });

  // ── /cari ──────────────────────────────────────────────────────────────────
  bot.command('cari', async (ctx) => {
    const query = ctx.message.text.replace('/cari', '').trim();
    if (!query) {
      pendingActions[ctx.from.id] = { action: 'search' };
      return ctx.reply('🔍 Ketik kata kunci:\nContoh: /cari foto liburan');
    }
    const opts = { query };
    pageSession[ctx.from.id] = { options: opts, tokenHistory: [null] };
    await showFileList(ctx, opts, 0, false);
  });

  // ── /bintang ───────────────────────────────────────────────────────────────
  bot.command('bintang', async (ctx) => {
    const opts = { starred: true };
    pageSession[ctx.from.id] = { options: opts, tokenHistory: [null] };
    await showFileList(ctx, opts, 0, false);
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
      const buttons = folders.map(f => [Markup.button.callback(`📁 ${f.name}`, `browsefolder_${f.id}`)]);
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
        '🌐 Upload dari URL\n\nKirimkan URL file yang ingin didownload dan diupload ke Drive.\n\nContoh:\nhttps://example.com/video.mp4',
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

  // ── /download ──────────────────────────────────────────────────────────────
  // Usage: /download https://drive.google.com/drive/folders/FOLDER_ID
  //        /download https://drive.google.com/file/d/FILE_ID/view
  bot.command('download', async (ctx) => {
    const input = ctx.message.text.replace('/download', '').trim();
    if (!input) {
      pendingActions[ctx.from.id] = { action: 'download_prompt' };
      return ctx.reply(
        '📥 Download dari Google Drive\n\n' +
        'Kirimkan link Drive yang ingin didownload:\n\n' +
        '📄 File: https://drive.google.com/file/d/FILE_ID/view\n' +
        '📁 Folder: https://drive.google.com/drive/folders/FOLDER_ID\n\n' +
        '⚠️ Untuk folder, semua file akan dikemas dalam ZIP (maks. 20 file).',
        Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'cancel')]])
      );
    }
    await handleDownloadLink(ctx, input);
  });

  /**
   * Parse Drive link → { type: 'file'|'folder', id }
   */
  function parseDriveLink(input) {
    // file: /file/d/ID
    let m = input.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return { type: 'file', id: m[1] };
    // folder: /folders/ID
    m = input.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (m) return { type: 'folder', id: m[1] };
    // open?id=ID
    m = input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return { type: 'file', id: m[1] };
    // bare ID (hanya karakter valid Drive)
    if (/^[a-zA-Z0-9_-]{25,}$/.test(input)) return { type: 'file', id: input };
    return null;
  }

  async function handleDownloadLink(ctx, input) {
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup. Ketik /setup');

    const parsed = parseDriveLink(input);
    if (!parsed) {
      return ctx.reply('❌ Link tidak dikenali. Pastikan formatnya:\nhttps://drive.google.com/file/d/ID/view\natau\nhttps://drive.google.com/drive/folders/ID');
    }

    if (parsed.type === 'file') {
      await downloadSingleFile(ctx, creds, parsed.id);
    } else {
      await downloadFolder(ctx, creds, parsed.id);
    }
  }

  // Export supaya bisa dipanggil dari text handler
  bot.handleDownloadLink = handleDownloadLink;

  // ── Download 1 file ────────────────────────────────────────────────────────
  async function downloadSingleFile(ctx, creds, fileId) {
    const statusMsg = await ctx.reply('🔍 Mengambil info file...');
    try {
      const { getFileInfo, isFilePublic, shareLink, downloadLink, formatBytes } = require('../lib/drive');
      const info = await getFileInfo(creds, fileId);
      const pub = await isFilePublic(creds, fileId);
      const isImage = info.mimeType.startsWith('image/');
      const isVideo = info.mimeType.startsWith('video/');

      // Kirim preview dulu (foto/video)
      const previewSent = await sendPreview(ctx, creds, info, fileId);

      // Edit status → info + tombol
      await ctx.telegram.editMessageText(
        ctx.chat.id, statusMsg.message_id, null,
        '📥 File siap didownload\n\n' +
        `📄 Nama: ${info.name}\n` +
        `📦 Ukuran: ${formatBytes(info.size)}\n` +
        `🗂️ Tipe: ${info.mimeType}\n` +
        `👁️ Akses: ${pub ? 'Publik 🌐' : 'Privat 🔒'}\n\n` +
        `🔗 Link View: ${shareLink(fileId)}\n` +
        `📥 Link Download: ${downloadLink(fileId)}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('📤 Kirim ke Chat', `sendfile_${fileId}`), Markup.button.callback('ℹ️ Info Lengkap', `info_${fileId}`)],
          [Markup.button.url('🌐 Buka di Drive', shareLink(fileId))],
        ])
      );
    } catch (e) {
      await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Gagal: ' + e.message);
    }
  }

  // ── Preview foto/video ─────────────────────────────────────────────────────
  async function sendPreview(ctx, creds, info, fileId) {
    try {
      const { downloadLink } = require('../lib/drive');
      if (info.mimeType.startsWith('image/')) {
        const url = downloadLink(fileId);
        await ctx.replyWithPhoto(url, { caption: `🖼 ${info.name}` });
        return true;
      }
      if (info.mimeType.startsWith('video/')) {
        // Video terlalu besar untuk dikirim langsung — kirim thumbnail placeholder
        await ctx.reply(`🎬 Preview: ${info.name}\n\n📦 Ukuran: ${require('../lib/drive').formatBytes(info.size)}\n\nFile video tidak di-preview langsung karena ukuran. Gunakan tombol di bawah untuk kirim ke chat.`);
        return true;
      }
    } catch (_) {}
    return false;
  }

  // ── Download folder → ZIP (batch, tanpa limit file) ───────────────────────
  const BATCH_SIZE = 50; // file per ZIP part

  async function downloadFolder(ctx, creds, folderId) {
    const archiver = require('archiver');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const axios = require('axios');
    const { listFolderContents, downloadLink, formatBytes } = require('../lib/drive');

    const statusMsg = await ctx.reply('🔍 Menganalisis isi folder...');
    try {
      // Rekursif kumpulkan semua file
      const allFiles = [];
      async function collectFiles(fid, prefix) {
        const items = await listFolderContents(creds, fid);
        for (const item of items) {
          if (item.mimeType === 'application/vnd.google-apps.folder') {
            await collectFiles(item.id, prefix + item.name + '/');
          } else {
            allFiles.push({ ...item, zipPath: prefix + item.name });
          }
        }
      }
      await collectFiles(folderId, '');

      if (allFiles.length === 0) {
        return ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Folder kosong.');
      }

      // Hitung total batch
      const totalBatches = Math.ceil(allFiles.length / BATCH_SIZE);
      const totalSize = allFiles.reduce((s, f) => s + parseInt(f.size || 0), 0);

      // Kirim preview foto (maks 3)
      const images = allFiles.filter(f => f.mimeType.startsWith('image/')).slice(0, 3);
      if (images.length > 0) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            `🖼 Preview foto dalam folder...`
          );
        } catch (_) {}
        for (const img of images) {
          try { await ctx.replyWithPhoto(downloadLink(img.id), { caption: `🖼 ${img.name}` }); } catch (_) {}
        }
      }

      // Kirim manifest (potong kalau terlalu panjang)
      const manifestLines = allFiles.map((f, i) => {
        const icon =
          f.mimeType.startsWith('image/') ? '🖼' :
          f.mimeType.startsWith('video/') ? '🎬' :
          f.mimeType.startsWith('audio/') ? '🎵' :
          f.mimeType === 'application/pdf' ? '📄' : '📁';
        return `${i + 1}. ${icon} ${f.zipPath} (${formatBytes(f.size)})`;
      });

      // Telegram max 4096 char — potong manifest jika perlu
      const header = `📂 Isi Folder — ${allFiles.length} file (${formatBytes(totalSize)})\n` +
        (totalBatches > 1 ? `📦 Akan dikirim dalam ${totalBatches} ZIP part\n` : '') + '\n';
      let manifestText = header;
      for (const line of manifestLines) {
        if ((manifestText + line + '\n').length > 4000) {
          manifestText += `... dan ${allFiles.length - manifestLines.indexOf(line)} file lainnya`;
          break;
        }
        manifestText += line + '\n';
      }
      await ctx.reply(manifestText);

      // Proses per batch
      for (let batch = 0; batch < totalBatches; batch++) {
        const batchFiles = allFiles.slice(batch * BATCH_SIZE, (batch + 1) * BATCH_SIZE);
        const partLabel = totalBatches > 1 ? ` (Part ${batch + 1}/${totalBatches})` : '';

        try {
          await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
            `📦 Memproses ZIP${partLabel}...\n\n[░░░░░░░░░░░░░░░░░░░░] 0%\n\n` +
            `📁 ${batchFiles.length} file dalam batch ini`
          );
        } catch (_) {}

        const zipPath = path.join(os.tmpdir(), `drivezip_${Date.now()}_part${batch + 1}.zip`);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.pipe(output);

        const tmpFiles = [];
        let failed = 0;

        for (let i = 0; i < batchFiles.length; i++) {
          const f = batchFiles[i];
          const globalIdx = batch * BATCH_SIZE + i + 1;
          const pct = Math.round((i / batchFiles.length) * 100);
          const filled = Math.round(pct / 5);
          const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);

          try {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
              `📦 Mengemas${partLabel}...\n[${bar}] ${pct}%\n\n` +
              `📄 ${globalIdx}/${allFiles.length}: ${f.name}`
            );
          } catch (_) {}

          const tmpFile = path.join(os.tmpdir(), `zipitem_${Date.now()}_${i}`);
          try {
            const response = await axios({
              url: downloadLink(f.id),
              method: 'GET',
              responseType: 'stream',
              timeout: 120000,
            });
            await new Promise((resolve, reject) => {
              const writer = fs.createWriteStream(tmpFile);
              response.data.pipe(writer);
              writer.on('finish', resolve);
              writer.on('error', reject);
            });
            archive.file(tmpFile, { name: f.zipPath });
            tmpFiles.push(tmpFile);
          } catch (_) {
            failed++;
          }
        }

        await new Promise((resolve, reject) => {
          output.on('close', resolve);
          archive.on('error', reject);
          archive.finalize();
        });

        const zipSize = fs.statSync(zipPath).size;

        // Cek ukuran ZIP — Telegram max 50MB untuk bot
        if (zipSize > 49 * 1024 * 1024) {
          await ctx.reply(
            `⚠️ ZIP Part ${batch + 1} terlalu besar (${formatBytes(zipSize)}) untuk dikirim via Telegram.\n\n` +
            `Batas Telegram: 50MB per file.\n` +
            `Gunakan /browse untuk download subfolder yang lebih kecil.`
          );
        } else {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null,
              `📤 Mengirim ZIP${partLabel} (${formatBytes(zipSize)})...`
            );
          } catch (_) {}

          const filename = totalBatches > 1
            ? `drive_part${batch + 1}of${totalBatches}_${Date.now()}.zip`
            : `drive_folder_${Date.now()}.zip`;

          await ctx.replyWithDocument(
            { source: zipPath, filename },
            { caption: `📦 Part ${batch + 1}/${totalBatches} — ${batchFiles.length} file — ${formatBytes(zipSize)}${failed > 0 ? `\n⚠️ ${failed} file gagal diunduh` : ''}` }
          );
        }

        // Cleanup batch ini
        try { fs.unlinkSync(zipPath); } catch (_) {}
        tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
      }

      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
      } catch (_) {}

      if (totalBatches > 1) {
        await ctx.reply(`✅ Selesai! Total ${totalBatches} ZIP terkirim untuk ${allFiles.length} file.`);
      }

    } catch (err) {
      console.error(err);
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Gagal download folder: ' + err.message);
      } catch (_) {}
    }
  }

  // ── Callback: kirim file ke chat ───────────────────────────────────────────
  bot.action(/^sendfile_(.+)$/, async (ctx) => {
    const fileId = ctx.match[1];
    const creds = await getUserCredentials(ctx.from.id);
    await ctx.answerCbQuery('📤 Mengirim file...');
    const statusMsg = await ctx.reply('⏳ Mengunduh & mengirim file...');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const axios = require('axios');
    try {
      const { getFileInfo, downloadLink, formatBytes } = require('../lib/drive');
      const info = await getFileInfo(creds, fileId);
      const tmpPath = path.join(os.tmpdir(), `send_${Date.now()}_${info.name}`);
      const dlUrl = downloadLink(fileId);

      const response = await axios({ url: dlUrl, method: 'GET', responseType: 'stream', timeout: 120000 });
      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmpPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      if (info.mimeType.startsWith('image/')) {
        await ctx.replyWithPhoto({ source: tmpPath }, { caption: `🖼 ${info.name} (${formatBytes(info.size)})` });
      } else if (info.mimeType.startsWith('video/')) {
        await ctx.replyWithVideo({ source: tmpPath }, { caption: `🎬 ${info.name} (${formatBytes(info.size)})` });
      } else if (info.mimeType.startsWith('audio/')) {
        await ctx.replyWithAudio({ source: tmpPath }, { caption: `🎵 ${info.name}` });
      } else {
        await ctx.replyWithDocument({ source: tmpPath, filename: info.name }, { caption: `📄 ${info.name} (${formatBytes(info.size)})` });
      }

      fs.unlinkSync(tmpPath);
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id);
    } catch (e) {
      try { await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, null, '❌ Gagal kirim file: ' + e.message); } catch (_) {}
    }
  });

  // ── /riwayat ───────────────────────────────────────────────────────────────
  bot.command('riwayat', async (ctx) => {
    await showHistory(ctx, 0, false);
  });

  async function showHistory(ctx, page, editMsg) {
    const { items, total, pages } = await getUploadHistory(ctx.from.id, page, 5);
    if (items.length === 0) {
      const msg = '📋 Belum ada riwayat upload.';
      return editMsg ? ctx.editMessageText(msg) : ctx.reply(msg);
    }
    let msg = `📋 Riwayat Upload (${page * 5 + 1}–${Math.min((page + 1) * 5, total)} dari ${total})\n\n`;
    items.forEach((item) => {
      const icon = item.mimeType?.startsWith('image/') ? '🖼' :
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
  bot.command('statistik', async (ctx) => { await showStats(ctx); });
  bot.action('show_stats', async (ctx) => { await ctx.answerCbQuery(); await showStats(ctx); });

  async function showStats(ctx) {
    const { getUploadStats } = require('../lib/users');
    const stats = await getUploadStats(ctx.from.id);
    let msg = `📊 Statistik Upload\n\n`;
    msg += `📁 Total upload: ${stats.total} file\n`;
    msg += `💾 Total ukuran: ${formatBytes(stats.totalSize)}\n\n`;
    msg += `Breakdown per kategori:\n`;
    for (const t of stats.byType) {
      const icons = { images: '🖼', videos: '🎬', audio: '🎵', documents: '📄', others: '📁' };
      msg += `${icons[t._id] || '📁'} ${t._id}: ${t.count} file (${formatBytes(t.totalSize)})\n`;
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

  // ── /uploadto ──────────────────────────────────────────────────────────────
  // Usage: /uploadto https://drive.google.com/drive/folders/FOLDER_ID
  // Atau /uploadto tanpa argumen → minta link
  bot.command('uploadto', async (ctx) => {
    const input = ctx.message.text.replace('/uploadto', '').trim();
    if (!input) {
      pendingActions[ctx.from.id] = { action: 'uploadto_prompt' };
      return ctx.reply(
        '📁 Upload ke Folder Drive\n\n' +
        'Kirimkan link folder Google Drive tujuan:\n\n' +
        'Contoh:\nhttps://drive.google.com/drive/folders/FOLDER_ID\n\n' +
        'Bot akan menampilkan isi folder & subfolder untuk kamu pilih.',
        Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'cancel')]])
      );
    }
    await handleUploadToLink(ctx, input);
  });

  async function handleUploadToLink(ctx, input) {
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup. Ketik /setup');

    const parsed = parseDriveLink(input);
    if (!parsed || parsed.type !== 'folder') {
      return ctx.reply('❌ Link tidak dikenali atau bukan folder.\n\nFormat: https://drive.google.com/drive/folders/FOLDER_ID');
    }

    await showFolderPicker(ctx, creds, parsed.id, null, false);
  }

  /**
   * Tampilkan picker folder untuk memilih tujuan upload.
   * @param {object} ctx
   * @param {object} creds
   * @param {string} folderId   - folder yang sedang ditampilkan
   * @param {string|null} parentId - parent folder untuk tombol Back (null = root link)
   * @param {boolean} edit      - edit pesan existing atau kirim baru
   */
  async function showFolderPicker(ctx, creds, folderId, parentId, edit) {
    try {
      const items = await listFolderContents(creds, folderId);
      const subfolders = items.filter(i => i.mimeType === 'application/vnd.google-apps.folder');
      const files = items.filter(i => i.mimeType !== 'application/vnd.google-apps.folder');

      // Info folder saat ini
      let folderName = 'Folder ini';
      try {
        const { getFileInfo } = require('../lib/drive');
        const info = await getFileInfo(creds, folderId);
        folderName = info.name;
      } catch (_) {}

      let msg = `📁 ${folderName}\n`;
      msg += `📄 ${files.length} file`;
      if (subfolders.length > 0) msg += ` • 📁 ${subfolders.length} subfolder`;
      msg += '\n\nPilih subfolder atau upload langsung ke sini:';

      const buttons = [];

      // Tombol upload ke folder ini (selalu tampil di atas)
      buttons.push([
        Markup.button.callback(`📤 Upload ke "${folderName.substring(0, 20)}"`, `uploadhere_${folderId}`)
      ]);

      // Subfolder (maks 20 tombol supaya tidak overflow)
      for (const sf of subfolders.slice(0, 20)) {
        buttons.push([
          Markup.button.callback(`📁 ${sf.name.substring(0, 30)}`, `pickfolder_${sf.id}_${folderId}`)
        ]);
      }

      if (subfolders.length > 20) {
        buttons.push([Markup.button.callback(`... dan ${subfolders.length - 20} subfolder lagi`, 'noop')]);
      }

      // Tombol back ke parent
      if (parentId) {
        buttons.push([Markup.button.callback('🔙 Kembali', `pickfolder_${parentId}_root`)]);
      }
      buttons.push([Markup.button.callback('❌ Batal', 'cancel')]);

      const markup = Markup.inlineKeyboard(buttons);
      if (edit) {
        await ctx.editMessageText(msg, markup);
      } else {
        await ctx.reply(msg, markup);
      }
    } catch (e) {
      const errMsg = '❌ Gagal membuka folder: ' + e.message;
      edit ? ctx.editMessageText(errMsg) : ctx.reply(errMsg);
    }
  }

  // Callback: navigasi folder di picker
  // format: pickfolder_{folderId}_{parentId}
  bot.action(/^pickfolder_([^_]+)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const folderId = ctx.match[1];
    const parentId = ctx.match[2] === 'root' ? null : ctx.match[2];
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup.');
    await showFolderPicker(ctx, creds, folderId, parentId, true);
  });

  // Callback noop (untuk label informatif)
  bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

  // Expose handleDownloadLink & handleUploadToLink untuk text handler di bot.js
  return { handleDownloadLink, handleUploadToLink };
}

module.exports = { registerCommands };
