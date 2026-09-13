/**
 * Todas as credenciais vêm de variáveis de ambiente / Firebase Secrets — nunca hardcode aqui.
 * Configurar em produção com:
 *   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *   ...etc
 */
export const config = {
  telegram: {
    // .trim() porque secrets configurados via `echo "valor" | firebase functions:secrets:set`
    // (sem -n) chegam aqui com uma quebra de linha grudada no final.
    // Token do bot, gerado pelo @BotFather no Telegram.
    botToken: (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
    // Chat ID (numérico, como string) autorizado a lançar despesas — só esse chat é atendido.
    ownerChatId: (process.env.TELEGRAM_OWNER_CHAT_ID ?? "").trim(),
    // Token arbitrário que você escolhe e passa também na hora de registrar o webhook
    // (setWebhook com secret_token) — usado para confirmar que a chamada é mesmo do Telegram.
    webhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim(),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    // Claude lê imagem/PDF nativamente — usado para extrair dados de notas, recibos e comprovantes.
    model: "claude-sonnet-5",
  },
  email: {
    // Usado para o botão "Enviar para reembolso por e-mail".
    smtpHost: process.env.SMTP_HOST ?? "",
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpUser: process.env.SMTP_USER ?? "",
    smtpPass: process.env.SMTP_PASS ?? "",
    secretaryEmail: process.env.SECRETARY_EMAIL ?? "",
    fromEmail: process.env.FROM_EMAIL ?? "",
  },
  storageBucketReceiptsPrefix: "recibos",
};
