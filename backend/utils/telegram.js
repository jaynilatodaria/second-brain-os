const axios = require("axios");

async function sendMessage(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id:    chatId,
      text,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.warn("[telegram] Failed to send:", err.message);
  }
}

module.exports = { sendMessage };
