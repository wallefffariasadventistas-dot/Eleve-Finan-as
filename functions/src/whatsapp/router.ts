import { config } from "../config";
import { sendButtons, sendText, downloadMedia } from "./client";
import { WhatsAppIncomingMessage } from "./types";
import { extractFromImage, extractFromPdf, extractFromText } from "../ai/expenseExtractor";
import { transcribeAudio } from "../ai/audioTranscriber";
import { salvarComprovante } from "../utils/storage";
import { criarDespesa, finalizarDespesa, buscarDespesa } from "../firestore/expenses";
import { criarRelatorioViagem, listarRelatoriosAbertos } from "../firestore/travelReports";
import { definirEstado, limparEstado, obterEstado } from "../firestore/conversationState";
import { CategoriaDespesa, ExtractedExpense, TipoDespesa } from "./types";

const TIPO_BOTOES: Array<{ id: `tipo_${TipoDespesa}`; title: string }> = [
  { id: "tipo_viagem", title: "Viagem" },
  { id: "tipo_departamento", title: "Departamento" },
  { id: "tipo_pessoal", title: "Pessoal" },
];

/** Ponto de entrada: só processa mensagens vindas do número autorizado (o dono). */
export async function processarMensagem(msg: WhatsAppIncomingMessage): Promise<void> {
  if (msg.from !== config.whatsapp.ownerNumber) {
    // Automação é de uso pessoal: qualquer outro número é ignorado silenciosamente.
    return;
  }

  const pendencia = await obterEstado(msg.from);
  if (pendencia) {
    await tratarResposta(msg, pendencia);
    return;
  }

  switch (msg.type) {
    case "text":
      await tratarTexto(msg.from, msg.text!.body);
      return;
    case "image": {
      const { buffer, mimeType } = await downloadMedia(msg.image!.id);
      const extraido = await extractFromImage(buffer, mimeType, msg.image!.caption);
      await lancarDespesa(msg.from, extraido, buffer, mimeType, "whatsapp-foto");
      return;
    }
    case "document": {
      const { buffer, mimeType } = await downloadMedia(msg.document!.id);
      const extraido =
        mimeType === "application/pdf"
          ? await extractFromPdf(buffer, msg.document!.caption)
          : await extractFromImage(buffer, mimeType, msg.document!.caption);
      await lancarDespesa(msg.from, extraido, buffer, mimeType, "whatsapp-comprovante");
      return;
    }
    case "audio": {
      const { buffer, mimeType } = await downloadMedia(msg.audio!.id);
      const transcricao = await transcribeAudio(buffer);
      const extraido = await extractFromText(transcricao);
      await lancarDespesa(msg.from, extraido, buffer, mimeType, "whatsapp-audio");
      return;
    }
    default:
      await sendText(msg.from, "Não consegui entender esse tipo de mensagem ainda. Envie foto, áudio, PDF ou texto descrevendo o gasto.");
  }
}

async function tratarTexto(from: string, texto: string): Promise<void> {
  const extraido = await extractFromText(texto);
  await lancarDespesa(from, extraido, null, null, "whatsapp-texto");
}

async function lancarDespesa(
  from: string,
  extraido: ExtractedExpense,
  arquivo: Buffer | null,
  mimeType: string | null,
  origem: "whatsapp-foto" | "whatsapp-audio" | "whatsapp-texto" | "whatsapp-comprovante"
): Promise<void> {
  if (extraido.valor === null) {
    await sendText(
      from,
      "Não consegui identificar o valor dessa despesa. Pode me enviar de novo ou escrever o valor?"
    );
    return;
  }

  const categoria: CategoriaDespesa = extraido.categoriaSugerida ?? "outros";
  const tipoDespesa = extraido.tipoDespesaSugerido;

  const despesaId = await criarDespesa({
    valor: extraido.valor,
    data: extraido.data,
    estabelecimento: extraido.estabelecimento,
    descricao: extraido.descricao,
    categoria,
    tipoDespesa,
    finalizado: false,
    relatorioViagemId: null,
    origem,
    comprovanteStoragePath: null,
  });

  if (arquivo && mimeType) {
    const path = await salvarComprovante(despesaId, arquivo, mimeType);
    await finalizarComprovante(despesaId, path);
  }

  if (extraido.confiancaBaixa) {
    await definirEstado(from, { aguardando: "confirmacao_valor", despesaId });
    await sendText(
      from,
      `Registrei um valor de R$ ${extraido.valor.toFixed(2)} mas não tenho certeza — está correto? ` +
        `Responda com o valor certo, ou "confirma" se estiver ok.`
    );
    return;
  }

  if (!tipoDespesa) {
    await definirEstado(from, { aguardando: "tipo_despesa", despesaId });
    await sendButtons(from, `Registrei R$ ${extraido.valor.toFixed(2)} (${categoria}). Essa despesa é de:`, TIPO_BOTOES);
    return;
  }

  await concluirComTipo(from, despesaId, tipoDespesa);
}

async function finalizarComprovante(despesaId: string, storagePath: string): Promise<void> {
  const { atualizarDespesa } = await import("../firestore/expenses");
  await atualizarDespesa(despesaId, { comprovanteStoragePath: storagePath });
}

async function concluirComTipo(from: string, despesaId: string, tipoDespesa: TipoDespesa): Promise<void> {
  if (tipoDespesa === "viagem") {
    const abertos = await listarRelatoriosAbertos();
    await definirEstado(from, { aguardando: "relatorio_viagem", despesaId });
    if (abertos.length === 0) {
      await sendText(from, "Qual o nome do relatório de viagem? (ex: \"Viagem São Paulo\")");
    } else {
      await sendButtons(
        from,
        "Em qual relatório de viagem lanço essa despesa?",
        abertos.slice(0, 2).map((r) => ({ id: `relatorio_${r.id}`, title: r.nome })).concat([
          { id: "relatorio_novo", title: "Nova viagem" },
        ])
      );
    }
    return;
  }

  await finalizarDespesa(despesaId, tipoDespesa, null);
  await sendText(from, `Lançado ✅ — ${tipoDespesa}, reembolsável.`.replace("pessoal, reembolsável", "pessoal"));
}

async function tratarResposta(
  msg: WhatsAppIncomingMessage,
  pendencia: NonNullable<Awaited<ReturnType<typeof obterEstado>>>
): Promise<void> {
  const from = msg.from;
  const respostaId = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
  const respostaTexto = msg.text?.body?.trim();

  if (pendencia.aguardando === "tipo_despesa") {
    const tipo = (respostaId?.replace("tipo_", "") ?? mapearTipoPorTexto(respostaTexto)) as TipoDespesa | null;
    if (!tipo) {
      await sendButtons(from, "Não entendi. Essa despesa é de:", TIPO_BOTOES);
      return;
    }
    await limparEstado(from);
    await concluirComTipo(from, pendencia.despesaId, tipo);
    return;
  }

  if (pendencia.aguardando === "relatorio_viagem") {
    let relatorioId: string;
    if (respostaId === "relatorio_novo" || (!respostaId && respostaTexto)) {
      relatorioId = await criarRelatorioViagem(respostaTexto ?? "Nova viagem");
    } else if (respostaId?.startsWith("relatorio_")) {
      relatorioId = respostaId.replace("relatorio_", "");
    } else {
      await sendText(from, "Qual o nome do relatório de viagem?");
      return;
    }
    await limparEstado(from);
    await finalizarDespesa(pendencia.despesaId, "viagem", relatorioId);
    await sendText(from, "Lançado ✅ — viagem, reembolsável.");
    return;
  }

  if (pendencia.aguardando === "confirmacao_valor") {
    const despesa = await buscarDespesa(pendencia.despesaId);
    if (!despesa) return;
    const { atualizarDespesa } = await import("../firestore/expenses");
    if (respostaTexto && !/^confirma/i.test(respostaTexto)) {
      const novoValor = Number(respostaTexto.replace(",", ".").replace(/[^0-9.]/g, ""));
      if (!Number.isNaN(novoValor) && novoValor > 0) {
        await atualizarDespesa(pendencia.despesaId, { valor: novoValor });
      }
    }
    await limparEstado(from);
    if (!despesa.tipoDespesa) {
      await definirEstado(from, { aguardando: "tipo_despesa", despesaId: pendencia.despesaId });
      await sendButtons(from, "Valor confirmado. Essa despesa é de:", TIPO_BOTOES);
    } else {
      await concluirComTipo(from, pendencia.despesaId, despesa.tipoDespesa);
    }
  }
}

function mapearTipoPorTexto(texto?: string): TipoDespesa | null {
  if (!texto) return null;
  const t = texto.toLowerCase();
  if (t.includes("viagem")) return "viagem";
  if (t.includes("depart")) return "departamento";
  if (t.includes("pessoal")) return "pessoal";
  return null;
}
