export async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatIdRaw = process.env.TELEGRAM_CHAT_ID?.trim();

  if (!token || !chatIdRaw) {
    throw new Error("Задайте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env");
  }

  const chatId = /^-?\d+$/.test(chatIdRaw) ? Number(chatIdRaw) : chatIdRaw;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
  });

  const json = (await res.json()) as { ok?: boolean; description?: string };

  if (!res.ok || json.ok === false) {
    throw new Error(json.description ?? `Telegram HTTP ${res.status}`);
  }
}
