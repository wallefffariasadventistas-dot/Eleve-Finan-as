import { config } from "../config";
import { sendButtons, sendText, downloadMedia, answerCallback } from "./client";
import { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./types";
import { extractFromImage, extractFromPdf, extractFromText } from "../ai/expenseExtractor";
import { transcribeAudio } from "../ai/audioTranscriber";
import { salvarComprovante } from "../utils/storage";
import { atualizarDespesa, buscarDespesa, criarDespesa, finalizarDespesa } from "../firestore/expenses";
import { criarRelatorioViagem, listarRelatoriosAbertos } from "../firestore/travelReports";
import { definirEstado, limparEstado, obterEstado, Pendencia } from "../firestore/conversationState";
import { CategoriaDespesa, ExtractedExpense, TipoDespesa } from "../types";

const TIPO_BOTOES: Array<{ id: `tipo_${TipoDespesa}`; title: string }> = [
  { id: "tipo_viagem", title: "Viagem" },
  { id: "tipo_departamento", title: "Departamento" },
  { id: "tipo_pessoal", title: "Pessoal" },
];

/** Ponto de entrada: roteia mensagens de texto/mídia e cliques em botão (callback_query). */
export async function processarUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await processarCallback(update.callback_query);
    return;
  }
  if (update.message) {
    await processarMensagem(update.message);
  }
}

async function processarCallback(callback: TelegramCallbackQuery): Promise<void> {
  await answerCallback(callback.id);

  const chatId = String(callback.message?.chat.id ?? callback.from.id);
  if (chatId !== config.telegram.ownerChatId) return;

  const pendencia = await obterEstado(chatId);
  if (!pendencia) return;
  await tratarResposta(chatId, { respostaId: callback.data }, pendencia);
}

async function processarMensagem(msg: TelegramMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  if (chatId !== config.telegram.ownerChatId) {
    // Automação é de uso pessoal: qualquer outro chat é ignorado silenciosamente.
    return;
  }

  const pendencia = await obterEstado(chatId);
  if (pendencia) {
    await tratarResposta(chatId, { respostaTexto: msg.text?.trim() }, pendencia);
    return;
  }

  if (msg.photo && msg.photo.length > 0) {
    const maior = msg.photo.reduce((a, b) => (b.width > a.width ? b : a));
    const { buffer, mimeType } = await downloadMedia(maior.file_id);
    const extraido = await extractFromImage(buffer, mimeType, msg.caption);
    await lancarDespesa(chatId, extraido, buffer, mimeType, "telegram-foto");
    return;
  }

  if (msg.document) {
    const { buffer, mimeType: mimeBaixado } = await downloadMedia(msg.document.file_id);
    const mimeType = msg.document.mime_type ?? mimeBaixado;
    const extraido =
      mimeType === "application/pdf"
        ? await extractFromPdf(buffer, msg.caption)
        : await extractFromImage(buffer, mimeType, msg.caption);
    await lancarDespesa(chatId, extraido, buffer, mimeType, "telegram-comprovante");
    return;
  }

  if (msg.voice) {
    const { buffer, mimeType } = await downloadMedia(msg.voice.file_id);
    const transcricao = await transcribeAudio(buffer);
    const extraido = await extractFromText(transcricao);
    await lancarDespesa(chatId, extraido, buffer, mimeType, "telegram-audio");
    return;
  }

  if (msg.text) {
    await tratarTexto(chatId, msg.text);
    return;
  }

  await sendText(
    chatId,
    "Não consegui entender essa mensagem ainda. Envie foto, PDF, nota de voz ou texto descrevendo o gasto."
  );
}

async function tratarTexto(chatId: string, texto: string): Promise<void> {
  const extraido = await extractFromText(texto);
  await lancarDespesa(chatId, extraido, null, null, "telegram-texto");
}

async function lancarDespesa(
  chatId: string,
  extraido: ExtractedExpense,
  arquivo: Buffer | null,
  mimeType: string | null,
  origem: "telegram-foto" | "telegram-audio" | "telegram-texto" | "telegram-comprovante"
): Promise<void> {
  if (extraido.valor === null) {
    await sendText(
      chatId,
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
    await atualizarDespesa(despesaId, { comprovanteStoragePath: path });
  }

  if (extraido.confiancaBaixa) {
    await definirEstado(chatId, { aguardando: "confirmacao_valor", despesaId });
    await sendText(
      chatId,
      `Registrei um valor de R$ ${extraido.valor.toFixed(2)} mas não tenho certeza — está correto? ` +
        `Responda com o valor certo, ou "confirma" se estiver ok.`
    );
    return;
  }

  if (!tipoDespesa) {
    await definirEstado(chatId, { aguardando: "tipo_despesa", despesaId });
    await sendButtons(chatId, `Registrei R$ ${extraido.valor.toFixed(2)} (${categoria}). Essa despesa é de:`, TIPO_BOTOES);
    return;
  }

  await concluirComTipo(chatId, despesaId, tipoDespesa);
}

async function concluirComTipo(chatId: string, despesaId: string, tipoDespesa: TipoDespesa): Promise<void> {
  if (tipoDespesa === "viagem") {
    const abertos = await listarRelatoriosAbertos();
    await definirEstado(chatId, { aguardando: "relatorio_viagem", despesaId });
    if (abertos.length === 0) {
      await sendText(chatId, 'Qual o nome do relatório de viagem? (ex: "Viagem São Paulo")');
    } else {
      await sendButtons(
        chatId,
        "Em qual relatório de viagem lanço essa despesa?",
        abertos
          .slice(0, 2)
          .map((r) => ({ id: `relatorio_${r.id}`, title: r.nome }))
          .concat([{ id: "relatorio_novo", title: "Nova viagem" }])
      );
    }
    return;
  }

  await finalizarDespesa(despesaId, tipoDespesa, null);
  await sendText(chatId, `Lançado ✅ — ${tipoDespesa}, reembolsável.`.replace("pessoal, reembolsável", "pessoal"));
}

async function tratarResposta(
  chatId: string,
  resposta: { respostaId?: string; respostaTexto?: string },
  pendencia: NonNullable<Pendencia>
): Promise<void> {
  const { respostaId, respostaTexto } = resposta;

  if (pendencia.aguardando === "tipo_despesa") {
    const tipo = (respostaId?.replace("tipo_", "") ?? mapearTipoPorTexto(respostaTexto)) as TipoDespesa | null;
    if (!tipo) {
      await sendButtons(chatId, "Não entendi. Essa despesa é de:", TIPO_BOTOES);
      return;
    }
    await limparEstado(chatId);
    await concluirComTipo(chatId, pendencia.despesaId, tipo);
    return;
  }

  if (pendencia.aguardando === "relatorio_viagem") {
    let relatorioId: string;
    if (respostaId === "relatorio_novo" || (!respostaId && respostaTexto)) {
      relatorioId = await criarRelatorioViagem(respostaTexto ?? "Nova viagem");
    } else if (respostaId?.startsWith("relatorio_")) {
      relatorioId = respostaId.replace("relatorio_", "");
    } else {
      await sendText(chatId, "Qual o nome do relatório de viagem?");
      return;
    }
    await limparEstado(chatId);
    await finalizarDespesa(pendencia.despesaId, "viagem", relatorioId);
    await sendText(chatId, "Lançado ✅ — viagem, reembolsável.");
    return;
  }

  if (pendencia.aguardando === "confirmacao_valor") {
    const despesa = await buscarDespesa(pendencia.despesaId);
    if (!despesa) return;
    if (respostaTexto && !/^confirma/i.test(respostaTexto)) {
      const novoValor = Number(respostaTexto.replace(",", ".").replace(/[^0-9.]/g, ""));
      if (!Number.isNaN(novoValor) && novoValor > 0) {
        await atualizarDespesa(pendencia.despesaId, { valor: novoValor });
      }
    }
    await limparEstado(chatId);
    if (!despesa.tipoDespesa) {
      await definirEstado(chatId, { aguardando: "tipo_despesa", despesaId: pendencia.despesaId });
      await sendButtons(chatId, "Valor confirmado. Essa despesa é de:", TIPO_BOTOES);
    } else {
      await concluirComTipo(chatId, pendencia.despesaId, despesa.tipoDespesa);
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
