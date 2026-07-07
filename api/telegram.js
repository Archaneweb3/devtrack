// kirim signal Telegram — kredensial dikirim dari browser (tersimpan di localStorage user)
const { sendTelegram, scanSignalHtml, watchlistSignalHtml, creatorSummary, json, readBody } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST saja' });
    const body = await readBody(req);
    const creds = { token: body.token, chatId: body.chatId };

    if (body.type === 'test') {
      await sendTelegram(creds, '✅ <b>devtrack terhubung!</b>\nSignal watchlist &amp; hasil scan akan dikirim ke chat ini.');
      return json(res, 200, { ok: true });
    }
    if (body.type === 'scan') {
      const { modeLabel, filter, devs } = body;
      if (!Array.isArray(devs) || !devs.length) return json(res, 400, { error: 'Tidak ada dev untuk dikirim' });
      await sendTelegram(creds, scanSignalHtml(modeLabel || 'SCAN', filter || { minLaunch: '-', minWinrate: '-' }, devs));
      return json(res, 200, { ok: true, sent: Math.min(devs.length, 10) });
    }
    if (body.type === 'watchlist') {
      const { wallet, label, coin } = body;
      if (!wallet || !coin?.mint) return json(res, 400, { error: 'Data signal tidak lengkap' });
      const stats = await creatorSummary(wallet);
      await sendTelegram(creds, watchlistSignalHtml({ wallet, label }, coin, stats));
      return json(res, 200, { ok: true });
    }
    json(res, 400, { error: 'type tidak dikenal' });
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};
