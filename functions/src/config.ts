/**
 * Todas as credenciais vêm de variáveis de ambiente / Firebase Secrets — nunca hardcode aqui.
 * Configurar em produção com:
 *   firebase functions:secrets:set WHATSAPP_TOKEN
 *   firebase functions:secrets:set ANTHROPIC_API_KEY
 *   ...etc
 */
export const config = {
  whatsapp: {
    // Token de acesso (temporário ou permanente) gerado no Meta for Developers.
    accessToken: process.env.WHATSAPP_TOKEN ?? "",
    // Phone Number ID do número de WhatsApp Business conectado ao App.
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    // Token arbitrário que você escolhe e cola também no campo "Verify Token" do Meta.
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    // Número (formato internacional, só dígitos, ex: 5511999999999) autorizado a lançar despesas.
    ownerNumber: process.env.WHATSAPP_OWNER_NUMBER ?? "",
    // Número da secretária para onde os pedidos de reembolso podem ser enviados por WhatsApp.
    secretaryNumber: process.env.WHATSAPP_SECRETARY_NUMBER ?? "",
    apiVersion: "v21.0",
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
