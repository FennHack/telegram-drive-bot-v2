const { Telegraf } = require('telegraf');
const { registerSetup, handleSetupInput } = require('./handlers/setup');
const { registerCommands } = require('./handlers/commands');
const { registerFileActions } = require('./handlers/fileactions');
const { handleMedia, handleUrlUpload } = require('./handlers/upload');
const { requireSetup } = require('./middleware/auth');
const { getUserCredentials } = require('./lib/users');

const bot = new Telegraf(process.env.BOT_TOKEN);

// ── State global ───────────────────────────────────────────────────────────────
const pendingActions = {};

// ── Register handlers ──────────────────────────────────────────────────────────
registerSetup(bot);
registerCommands(bot, pendingActions);
registerFileActions(bot, pendingActions);

// ── Media upload handlers ──────────────────────────────────────────────────────
bot.on('photo', requireSetup, async (ctx) => {
  const pending = pendingActions[ctx.from.id];
  const folderId = pending?.action === 'upload_to_folder' ? pending.folderId : null;
  if (folderId) delete pendingActions[ctx.from.id];
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  await handleMedia(ctx, photo.file_id, `photo_${Date.now()}.jpg`, 'image/jpeg', folderId);
});

bot.on('video', requireSetup, async (ctx) => {
  const pending = pendingActions[ctx.from.id];
  const folderId = pending?.action === 'upload_to_folder' ? pending.folderId : null;
  if (folderId) delete pendingActions[ctx.from.id];
  const video = ctx.message.video;
  const ext = video.mime_type?.split('/')[1] || 'mp4';
  await handleMedia(ctx, video.file_id, `video_${Date.now()}.${ext}`, video.mime_type || 'video/mp4', folderId);
});

bot.on('document', requireSetup, async (ctx) => {
  const pending = pendingActions[ctx.from.id];
  const folderId = pending?.action === 'upload_to_folder' ? pending.folderId : null;
  if (folderId) delete pendingActions[ctx.from.id];
  const doc = ctx.message.document;
  await handleMedia(ctx, doc.file_id, doc.file_name || `file_${Date.now()}`, doc.mime_type || 'application/octet-stream', folderId);
});

bot.on('audio', requireSetup, async (ctx) => {
  const audio = ctx.message.audio;
  const fileName = audio.file_name || `audio_${Date.now()}.mp3`;
  await handleMedia(ctx, audio.file_id, fileName, audio.mime_type || 'audio/mpeg', null);
});

bot.on('voice', requireSetup, async (ctx) => {
  await handleMedia(ctx, ctx.message.voice.file_id, `voice_${Date.now()}.ogg`, 'audio/ogg', null);
});

// ── Text handler ───────────────────────────────────────────────────────────────
bot.on('text', async (ctx) => {
  // Setup flow takes priority
  if (handleSetupInput(ctx, pendingActions)) return;

  const pending = pendingActions[ctx.from.id];
  if (!pending) return;

  const text = ctx.message.text.trim();

  // Cek setup sebelum handle pending actions
  const { isSetup } = require('./lib/users');
  if (!(await isSetup(ctx.from.id))) {
    delete pendingActions[ctx.from.id];
    return ctx.reply('❌ Belum setup. Ketik /setup');
  }

  const creds = await getUserCredentials(ctx.from.id);

  if (pending.action === 'rename') {
    delete pendingActions[ctx.from.id];
    const { renameFile, getFileInfo, isFilePublic, shareLink } = require('./lib/drive');
    try {
      await renameFile(creds, pending.fileId, text);
      const info = await getFileInfo(creds, pending.fileId);
      const pub = await isFilePublic(creds, pending.fileId);
      const { fileMenuButtons } = require('./handlers/upload');
      await ctx.reply(
        '✅ File berhasil direname!\n\n' +
        `📄 Nama baru: ${info.name}\n` +
        `🔗 Link: ${shareLink(pending.fileId)}`,
        fileMenuButtons(pending.fileId, pub, info.starred)
      );
    } catch (e) {
      await ctx.reply('❌ Gagal rename: ' + e.message);
    }

  } else if (pending.action === 'search') {
    delete pendingActions[ctx.from.id];
    const { listFiles, formatBytes, shareLink } = require('./lib/drive');
    try {
      const { files } = await listFiles(creds, { query: text, pageSize: 8 });
      if (files.length === 0) return ctx.reply(`🔍 Tidak ada file dengan nama "${text}".`);
      const { Markup } = require('telegraf');
      let msg = `🔍 Hasil: "${text}" (${files.length} file)\n\n`;
      const buttons = [];
      files.forEach((f, i) => {
        msg += `${i + 1}. ${f.name} (${formatBytes(f.size)})\n`;
        buttons.push([Markup.button.callback(`📄 ${f.name.substring(0, 28)}`, `info_${f.id}`)]);
      });
      await ctx.reply(msg, Markup.inlineKeyboard(buttons));
    } catch (e) {
      await ctx.reply('❌ Gagal cari: ' + e.message);
    }

  } else if (pending.action === 'uploadurl') {
    delete pendingActions[ctx.from.id];
    if (!text.startsWith('http')) return ctx.reply('❌ URL tidak valid. Harus dimulai dengan http');
    await handleUrlUpload(ctx, text, null);

  } else if (pending.action === 'newfolder') {
    delete pendingActions[ctx.from.id];
    const { createFolder, folderLink } = require('./lib/drive');
    const { Markup } = require('telegraf');
    try {
      const folder = await createFolder(creds, text, null);
      await ctx.reply(
        '✅ Folder berhasil dibuat!\n\n' +
        `🗂️ Nama: ${folder.name}\n` +
        `🔗 Link: ${folderLink(folder.id)}`,
        Markup.inlineKeyboard([[Markup.button.callback('📤 Upload ke sini', `uploadhere_${folder.id}`)]])
      );
    } catch (e) {
      await ctx.reply('❌ Gagal: ' + e.message);
    }
  }
});

module.exports = bot;
