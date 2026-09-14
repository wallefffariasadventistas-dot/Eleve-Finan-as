import { onCall, HttpsError } from "firebase-functions/v2/https";
import nodemailer from "nodemailer";
import { config } from "../config";
import { listarPendentesDeReembolso, marcarStatusReembolso, buscarDespesa } from "../firestore/expenses";
import { obterConfiguracoesReembolso } from "../firestore/settings";
import { gerarUrlAssinada } from "../utils/storage";
import { TipoDespesa } from "../types";

export type Fundo = "fundo10" | "publicacoes";

const FUNDO_LABEL: Record<Fundo, string> = {
  fundo10: "Fundo 10",
  publicacoes: "Publicações",
};

interface EnviarReembolsoRequest {
  fundo: Fundo;
  tipoDespesa?: TipoDespesa;
  relatorioViagemId?: string;
  /** Se enviado, usa exatamente essa lista em vez de buscar todas as pendentes do filtro acima. */
  despesaIds?: string[];
}

function montarEmail(
  despesas: Awaited<ReturnType<typeof listarPendentesDeReembolso>>,
  links: string[],
  fundo: Fundo,
  { contaReembolso, centroCusto }: { contaReembolso: string; centroCusto: string }
): { assunto: string; corpo: string } {
  const total = despesas.reduce((soma, d) => soma + (d.valor ?? 0), 0);
  const fundoLabel = FUNDO_LABEL[fundo];
  const linhas = despesas.map((d, i) => {
    const link = links[i] ? ` — recibo: ${links[i]}` : "";
    return `• ${d.data ?? "sem data"} | ${d.categoria} | R$ ${(d.valor ?? 0).toFixed(2)} | ${d.descricao}${link}`;
  });

  const assunto = `Solicitação de Reembolso — Departamento — ${fundoLabel}`;
  const corpo = [
    `Assunto: Solicitação de reembolso de despesas de departamento — ${fundoLabel}`,
    "",
    "Prezada secretaria,",
    "",
    "Segue solicitação de reembolso das despesas de departamento relacionadas abaixo, com os respectivos comprovantes.",
    "",
    "Dados para o reembolso:",
    `• Conta para reembolso: ${contaReembolso || "—"}`,
    `• Centro de custo: ${centroCusto || "—"}`,
    `• Fundo: ${fundoLabel}`,
    "",
    "Despesas:",
    linhas.join("\n"),
    "",
    `Total: R$ ${total.toFixed(2)} (${despesas.length} despesa(s))`,
  ].join("\n");

  return { assunto, corpo };
}

/**
 * Callable a partir do dashboard web: junta os recibos + resumo das despesas reembolsáveis
 * selecionadas e envia por e-mail para a secretária. Marca as despesas como "enviado".
 */
export const enviarParaReembolso = onCall<EnviarReembolsoRequest>(
  {
    secrets: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SECRETARY_EMAIL", "FROM_EMAIL"],
  },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError("unauthenticated", "É preciso estar autenticado no Eleve.");
    }

    const { fundo, tipoDespesa, relatorioViagemId, despesaIds } = req.data;

    if (fundo !== "fundo10" && fundo !== "publicacoes") {
      throw new HttpsError("invalid-argument", 'Escolha o fundo ("fundo10" ou "publicacoes").');
    }

    const despesas = despesaIds
      ? (await Promise.all(despesaIds.map(buscarDespesa))).filter((d): d is NonNullable<typeof d> => d !== null)
      : await listarPendentesDeReembolso(tipoDespesa, relatorioViagemId);

    if (despesas.length === 0) {
      throw new HttpsError("not-found", "Nenhuma despesa pendente de reembolso encontrada.");
    }

    const links = await Promise.all(
      despesas.map((d) => (d.comprovanteStoragePath ? gerarUrlAssinada(d.comprovanteStoragePath) : Promise.resolve("")))
    );
    const configuracoesReembolso = await obterConfiguracoesReembolso();
    const { assunto, corpo } = montarEmail(despesas, links, fundo, configuracoesReembolso);

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
      subject: assunto,
      text: corpo,
    });

    await marcarStatusReembolso(despesas.map((d) => d.id), "enviado");
    return { enviado: despesas.length };
  }
);
