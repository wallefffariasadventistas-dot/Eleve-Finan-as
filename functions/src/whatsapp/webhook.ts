import { onRequest } from "firebase-functions/v2/https";
import { config } from "../config";
import { processarMensagem } from "./router";
import { WhatsAppWebhookBody } from "./types";

/**
 * Endpoint único exposto ao Meta:
 *  GET  -> verificação do webhook (hub.challenge)
 *  POST -> recebimento de mensagens
 * Configurar no Meta for Developers > WhatsApp > Configuration > Webhook:
 *   Callback URL: https://<region>-<project-id>.cloudfunctions.net/whatsappWebhook
 *   Verify token: o mesmo valor de WHATSAPP_VERIFY_TOKEN
 */
export const whatsappWebhook = onRequest(
  { secrets: ["WHATSAPP_TOKEN", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_OWNER_NUMBER", "ANTHROPIC_API_KEY"] },
  async (req, res) => {
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
        res.status(200).send(challenge);
        return;
      }
      res.sendStatus(403);
      return;
    }

    if (req.method === "POST") {
      // Responde 200 imediatamente (a Meta reenvia se não receber ack rápido) e processa depois.
      res.sendStatus(200);
      try {
        const body = req.body as WhatsAppWebhookBody;
        const messages = body.entry?.[0]?.changes?.[0]?.value?.messages ?? [];
        for (const msg of messages) {
          await processarMensagem(msg);
        }
      } catch (err) {
        console.error("Erro ao processar webhook do WhatsApp:", err);
      }
      return;
    }

    res.sendStatus(405);
  }
);
