const { Markup } = require('telegraf');
const { saveUser, getUser, deleteUser, getUserCredentials } = require('../lib/users');
const { getStorageQuota, formatBytes } = require('../lib/drive');

const setupState = {}; // { userId: { step, clientId, clientSecret } }

function registerSetup(bot) {

  // ── /setup ─────────────────────────────────────────────────────────────────
  bot.command('setup', async (ctx) => {
    const user = await getUser(ctx.from.id);
    if (user && user.clientId) {
      return ctx.reply(
        '✅ Kamu sudah terhubung ke Google Drive!\n\n' +
        'Untuk logout atau ganti akun, ketik /logout',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Ganti Akun', 'setup_reauth')],
          [Markup.button.callback('❌ Logout', 'setup_logout')],
        ])
      );
    }
    await startSetup(ctx);
  });

  bot.action('setup_reauth', async (ctx) => {
    await ctx.answerCbQuery();
    await startSetup(ctx);
  });

  bot.action('setup_logout', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      '⚠️ Yakin ingin logout? Semua credentials kamu akan dihapus.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ya, Logout', 'confirm_logout')],
        [Markup.button.callback('❌ Batal', 'cancel_setup')],
      ])
    );
  });

  bot.action('confirm_logout', async (ctx) => {
    await deleteUser(ctx.from.id);
    delete setupState[ctx.from.id];
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      '✅ Logout berhasil. Ketik /setup untuk login ulang.'
    );
  });

  bot.action('cancel_setup', async (ctx) => {
    delete setupState[ctx.from.id];
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.editMessageText('❌ Setup dibatalkan.');
  });

  // ── /myaccount ─────────────────────────────────────────────────────────────
  bot.command('myaccount', async (ctx) => {
    const creds = await getUserCredentials(ctx.from.id);
    if (!creds) return ctx.reply('❌ Belum setup. Ketik /setup');
    try {
      const quota = await getStorageQuota(creds);
      const used = parseInt(quota.usage || 0);
      const total = parseInt(quota.limit || 0);
      const pct = total > 0 ? ((used / total) * 100).toFixed(1) : '?';
      const filled = total > 0 ? Math.round(used / total * 20) : 0;
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      await ctx.reply(
        '👤 Akun Kamu\n\n' +
        `🆔 Telegram ID: ${ctx.from.id}\n` +
        `👤 Nama: ${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}\n\n` +
        '☁️ Google Drive:\n' +
        `[${bar}] ${pct}%\n` +
        `📦 Terpakai: ${formatBytes(used)} / ${formatBytes(total)}\n` +
        `✅ Sisa: ${formatBytes(total - used)}\n\n` +
        `🤖 Auto Organize: ${creds.autoOrganize ? '✅ Aktif' : '❌ Nonaktif'}\n` +
        `📁 Default Folder: ${creds.defaultFolderId ? '✅ Set' : '❌ Belum set'}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🤖 Toggle Auto Organize', 'toggle_auto_organize')],
          [Markup.button.callback('📁 Set Default Folder Upload', 'set_default_folder')],
          [Markup.button.callback('🔄 Ganti Akun', 'setup_reauth')],
        ])
      );
    } catch (e) {
      ctx.reply('❌ Gagal mengambil info akun: ' + e.message);
    }
  });

  bot.action('toggle_auto_organize', async (ctx) => {
    const creds = await getUserCredentials(ctx.from.id);
    const { setAutoOrganize } = require('../lib/users');
    const newVal = !creds.autoOrganize;
    await setAutoOrganize(ctx.from.id, newVal);
    await ctx.answerCbQuery(newVal ? '🤖 Auto Organize diaktifkan!' : '❌ Auto Organize dinonaktifkan');
    await ctx.reply(
      newVal
        ? '🤖 Auto Organize AKTIF\n\nFile akan otomatis dimasukkan ke folder:\n📷 Images, 🎬 Videos, 🎵 Audio, 📄 Documents, dll.'
        : '❌ Auto Organize NONAKTIF\n\nFile akan diupload ke folder default atau root Drive.'
    );
  });

  bot.action('set_default_folder', async (ctx) => {
    await ctx.answerCbQuery();
    const creds = await getUserCredentials(ctx.from.id);
    const { listFolders } = require('../lib/drive');
    try {
      const folders = await listFolders(creds);
      if (folders.length === 0) {
        return ctx.reply('📁 Belum ada folder di Drive. Buat dulu dengan /newfolder');
      }
      const buttons = folders.map(f => [Markup.button.callback(`📁 ${f.name}`, `setdef_${f.id}_${encodeURIComponent(f.name)}`)]);
      buttons.push([Markup.button.callback('🗂️ Root Drive (tidak ada folder default)', 'setdef_root_Root')]);
      await ctx.reply('📁 Pilih folder default untuk upload:', Markup.inlineKeyboard(buttons));
    } catch (e) {
      ctx.reply('❌ Gagal: ' + e.message);
    }
  });

  bot.action(/^setdef_(.+)_(.+)$/, async (ctx) => {
    const folderId = ctx.match[1];
    const folderName = decodeURIComponent(ctx.match[2]);
    const { setDefaultFolder } = require('../lib/users');
    if (folderId === 'root') {
      await setDefaultFolder(ctx.from.id, null, null);
      await ctx.answerCbQuery('✅ Default folder dihapus');
      await ctx.editMessageText('✅ Upload akan ke root Drive.');
    } else {
      await setDefaultFolder(ctx.from.id, folderId, folderName);
      await ctx.answerCbQuery('✅ Default folder diset!');
      await ctx.editMessageText(`✅ Default folder: ${folderName}\nSemua upload akan masuk ke folder ini.`);
    }
  });
}

async function startSetup(ctx) {
  setupState[ctx.from.id] = { step: 'client_id' };
  await ctx.reply(
    '🔐 Setup Google Drive Bot\n\n' +
    'Saya akan memandu kamu menghubungkan akun Google Drive.\n\n' +
    'Kamu butuh:\n' +
    '1. Client ID\n' +
    '2. Client Secret\n' +
    '3. Refresh Token\n\n' +
    'Belum punya? Ikuti panduan:\n' +
    '1. Buka console.cloud.google.com\n' +
    '2. Buat project → aktifkan Google Drive API\n' +
    '3. Buat OAuth Client ID (Web App)\n' +
    '4. Dapatkan Refresh Token via OAuth Playground\n\n' +
    '📋 Kirimkan Client ID kamu sekarang:',
    Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', 'cancel_setup')]])
  );
}

function handleSetupInput(ctx, pendingActions) {
  const state = setupState[ctx.from.id];
  if (!state) return false;

  const text = ctx.message.text.trim();

  if (state.step === 'client_id') {
    if (!text.includes('.apps.googleusercontent.com')) {
      ctx.reply('❌ Format Client ID tidak valid. Harus berakhiran .apps.googleusercontent.com\n\nCoba lagi:');
      return true;
    }
    setupState[ctx.from.id] = { step: 'client_secret', clientId: text };
    ctx.reply('✅ Client ID tersimpan!\n\n📋 Sekarang kirimkan Client Secret kamu:');
    return true;
  }

  if (state.step === 'client_secret') {
    if (!text.startsWith('GOCSPX-')) {
      ctx.reply('❌ Format Client Secret tidak valid. Harus dimulai dengan GOCSPX-\n\nCoba lagi:');
      return true;
    }
    setupState[ctx.from.id] = { ...state, step: 'refresh_token', clientSecret: text };
    ctx.reply(
      '✅ Client Secret tersimpan!\n\n' +
      '📋 Sekarang kirimkan Refresh Token kamu.\n\n' +
      'Belum punya? Buka:\nhttps://developers.google.com/oauthplayground\n\n' +
      'Gunakan Client ID & Secret tadi, pilih scope:\nhttps://www.googleapis.com/auth/drive'
    );
    return true;
  }

  if (state.step === 'refresh_token') {
    if (!text.startsWith('1//')) {
      ctx.reply('❌ Format Refresh Token tidak valid. Harus dimulai dengan 1//\n\nCoba lagi:');
      return true;
    }

    // Simpan dan selesai
    const { clientId, clientSecret } = state;
    delete setupState[ctx.from.id];

    saveUser(ctx.from.id, {
      clientId,
      clientSecret,
      refreshToken: text,
      firstName: ctx.from.first_name,
      username: ctx.from.username,
      autoOrganize: false,
    }).then(async () => {
      // Test koneksi
      try {
        const { getStorageQuota, formatBytes } = require('../lib/drive');
        const quota = await getStorageQuota({ clientId, clientSecret, refreshToken: text });
        const used = parseInt(quota.usage || 0);
        const total = parseInt(quota.limit || 0);
        ctx.reply(
          '✅ Setup berhasil! Google Drive terhubung!\n\n' +
          `📦 Storage: ${formatBytes(used)} / ${formatBytes(total)}\n` +
          `✅ Sisa: ${formatBytes(total - used)}\n\n` +
          '🚀 Sekarang kamu bisa:\n' +
          '• Kirim foto/video untuk upload\n' +
          '• /drive - lihat file\n' +
          '• /uploadurl - upload dari link\n' +
          '• /storage - cek storage\n' +
          '• /myaccount - pengaturan akun\n' +
          '• /help - bantuan lengkap'
        );
      } catch (e) {
        ctx.reply(
          '⚠️ Credentials tersimpan tapi gagal terhubung ke Drive.\n' +
          'Pastikan Client ID, Secret, dan Refresh Token benar.\n\n' +
          'Error: ' + e.message + '\n\n' +
          'Coba /setup lagi untuk mengulang.'
        );
      }
    });
    return true;
  }

  return false;
}

module.exports = { registerSetup, handleSetupInput };
