import { onRequest } from "firebase-functions/v2/https";
import { config } from "../config";
import { processarUpdate } from "./router";
import { TelegramUpdate } from "./types";

/**
 * Endpoint único exposto ao Telegram (configurar com setWebhook apontando pra cá):
 *   https://<region>-<project-id>.cloudfunctions.net/telegramWebhook
 * O Telegram manda o header X-Telegram-Bot-Api-Secret-Token em toda chamada quando o
 * webhook é registrado com secret_token — conferimos ele pra garantir que a chamada é
 * mesmo do Telegram (qualquer um que descubra a URL não consegue forjar mensagens).
 */
export const telegramWebhook = onRequest(
  { secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    if (config.telegram.webhookSecret) {
      const recebido = req.get("X-Telegram-Bot-Api-Secret-Token");
      if (recebido !== config.telegram.webhookSecret) {
        res.sendStatus(401);
        return;
      }
    }

    // Responde 200 imediatamente (o Telegram reenvia se não receber ack rápido) e processa depois.
    res.sendStatus(200);
    try {
      const update = req.body as TelegramUpdate;
      await processarUpdate(update);
    } catch (err) {
      console.error(`Erro ao processar update do Telegram: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }
);
