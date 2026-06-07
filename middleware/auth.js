const { isSetup } = require('../lib/users');

async function requireSetup(ctx, next) {
  const setup = await isSetup(ctx.from.id);
  if (!setup) {
    await ctx.reply(
      '⚠️ Kamu belum setup akun Google Drive!\n\n' +
      'Ketik /setup untuk memulai proses login dengan akun Google Drive kamu.\n\n' +
      'Setiap user punya Drive masing-masing — data kamu aman dan terisolasi.'
    );
    return;
  }
  return next();
}

module.exports = { requireSetup };
