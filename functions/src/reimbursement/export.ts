import { onCall, HttpsError } from "firebase-functions/v2/https";
import nodemailer from "nodemailer";
import { config } from "../config";
import { listarPendentesDeReembolso, marcarStatusReembolso, buscarDespesa } from "../firestore/expenses";
import { gerarUrlAssinada } from "../utils/storage";
import { sendText } from "../whatsapp/client";
import { TipoDespesa } from "../whatsapp/types";

interface EnviarReembolsoRequest {
  canal: "email" | "whatsapp";
  tipoDespesa?: TipoDespesa;
  relatorioViagemId?: string;
  /** Se enviado, usa exatamente essa lista em vez de buscar todas as pendentes do filtro acima. */
  despesaIds?: string[];
}

function montarResumo(
  despesas: Awaited<ReturnType<typeof listarPendentesDeReembolso>>,
  links: string[]
): string {
  const total = despesas.reduce((soma, d) => soma + (d.valor ?? 0), 0);
  const linhas = despesas.map((d, i) => {
    const link = links[i] ? ` — recibo: ${links[i]}` : "";
    return `• ${d.data ?? "sem data"} | ${d.categoria} | R$ ${(d.valor ?? 0).toFixed(2)} | ${d.descricao}${link}`;
  });
  return `Solicitação de reembolso — Eleve\n\nTotal: R$ ${total.toFixed(2)} (${despesas.length} despesa(s))\n\n${linhas.join("\n")}`;
}

/**
 * Callable a partir do dashboard web: junta os recibos + resumo das despesas reembolsáveis
 * selecionadas e envia para a secretária, por e-mail ou WhatsApp. Marca as despesas como "enviado".
 */
export const enviarParaReembolso = onCall<EnviarReembolsoRequest>(
  { secrets: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"] },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError("unauthenticated", "É preciso estar autenticado no Eleve.");
    }

    const { canal, tipoDespesa, relatorioViagemId, despesaIds } = req.data;

    const despesas = despesaIds
      ? (await Promise.all(despesaIds.map(buscarDespesa))).filter((d): d is NonNullable<typeof d> => d !== null)
      : await listarPendentesDeReembolso(tipoDespesa, relatorioViagemId);

    if (despesas.length === 0) {
      throw new HttpsError("not-found", "Nenhuma despesa pendente de reembolso encontrada.");
    }

    const links = await Promise.all(
      despesas.map((d) => (d.comprovanteStoragePath ? gerarUrlAssinada(d.comprovanteStoragePath) : Promise.resolve("")))
    );
    const resumo = montarResumo(despesas, links);

    if (canal === "email") {
      if (!config.email.secretaryEmail) {
        throw new HttpsError("failed-precondition", "E-mail da secretária não configurado (SECRETARY_EMAIL).");
      }
      const transporter = nodemailer.createTransport({
        host: config.email.smtpHost,
        port: config.email.smtpPort,
        secure: config.email.smtpPort === 465,
        auth: { user: config.email.smtpUser, pass: config.email.smtpPass },
      });
      await transporter.sendMail({
        from: config.email.fromEmail,
        to: config.email.secretaryEmail,
        subject: `Reembolso Eleve — ${despesas.length} despesa(s)`,
        text: resumo,
      });
    } else {
      if (!config.whatsapp.secretaryNumber) {
        throw new HttpsError("failed-precondition", "Número da secretária não configurado (WHATSAPP_SECRETARY_NUMBER).");
      }
      await sendText(config.whatsapp.secretaryNumber, resumo);
    }

    await marcarStatusReembolso(despesas.map((d) => d.id), "enviado");
    return { enviado: despesas.length };
  }
);
