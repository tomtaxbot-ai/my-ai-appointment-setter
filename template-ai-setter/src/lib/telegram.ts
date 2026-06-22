/**
 * TELEGRAM PING
 * -------------
 * Pings Maher on the EXISTING Jarvis Telegram bot when the setter hands a lead
 * off to a human (business owner, friend, or unclear/needs-review).
 *
 * We do NOT create a new bot — we reuse the same bot token. Token + chat id come
 * from environment variables (set in Vercel in production):
 *   TELEGRAM_BOT_TOKEN  — the existing Jarvis bot token
 *   TELEGRAM_CHAT_ID    — Maher's chat id (falls back to TELEGRAM_AUTHORIZED_USER_ID)
 *
 * Send: POST https://api.telegram.org/bot{TOKEN}/sendMessage
 *       body {"chat_id": <id>, "text": "<msg>"}
 */

export interface TelegramResult {
  success: boolean;
  status?: number;
  error?: string;
}

function getChatId(): string | undefined {
  return process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_AUTHORIZED_USER_ID;
}

/**
 * Send a plain-text message to Maher. Best-effort: never throws — on any
 * failure (missing env, network, API error) it logs and returns success:false
 * so the caller's handoff still completes (tag + pause already happened).
 */
export async function sendTelegramPing(text: string): Promise<TelegramResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = getChatId();

  if (!token || !chatId) {
    console.error(
      "[telegram] missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID — ping skipped"
    );
    return { success: false, error: "missing_telegram_env" };
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[telegram] sendMessage failed:", response.status, errorText);
      return { success: false, status: response.status, error: errorText };
    }
    return { success: true, status: response.status };
  } catch (err) {
    console.error("[telegram] sendMessage threw:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/** GHL contact deep-link used in every handoff ping. */
export function ghlContactLink(locationId: string, contactId: string): string {
  return `https://app.gohighlevel.com/v2/location/${locationId}/contacts/detail/${contactId}`;
}
