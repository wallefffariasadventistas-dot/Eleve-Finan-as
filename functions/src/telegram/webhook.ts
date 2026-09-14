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
  {
    secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_OWNER_CHAT_ID", "TELEGRAM_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"],
    // Baixar a mídia + chamar a IA pode levar alguns segundos — dá folga acima do padrão (60s).
    timeoutSeconds: 120,
  },
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

    // Processa e só responde ao Telegram depois de terminar: no Cloud Run (base do 2nd gen),
    // a instância só recebe CPU garantida ENQUANTO a resposta HTTP não foi enviada — responder
    // 200 antes e continuar processando "em segundo plano" faz esse trabalho ficar sujeito a
    // limitação de CPU e demorar minutos em vez de segundos.
    try {
      const update = req.body as TelegramUpdate;
      const msg = update.message;
      console.log(
        `[diag] update_id=${update.update_id} tipo=${msg ? "message" : update.callback_query ? "callback" : "?"} ` +
          `media_group_id=${msg?.media_group_id ?? "-"} tem_photo=${!!msg?.photo?.length} tem_document=${!!msg?.document} ` +
          `callback_data=${update.callback_query?.data ?? "-"} texto=${JSON.stringify(msg?.text?.slice(0, 80) ?? "-")}`
      );
      await processarUpdate(update);
    } catch (err) {
      console.error(`Erro ao processar update do Telegram: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    res.sendStatus(200);
  }
);
