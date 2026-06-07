const bot = require('../bot');

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      await bot.handleUpdate(req.body);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Bot error:', err);
      res.status(200).json({ ok: true }); // tetap 200 agar Telegram tidak retry
    }
  } else {
    res.status(200).json({ status: 'Drive Bot v2 is running 🚀' });
  }
};
