// konfigurasi publik untuk frontend (Client ID Google bukan rahasia)
const { json } = require('../lib/core');

module.exports = async (req, res) => {
  json(res, 200, { googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
};
