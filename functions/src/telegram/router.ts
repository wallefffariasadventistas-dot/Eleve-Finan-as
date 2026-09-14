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

  const despesaId = await criarDespesa({
    valor: extraido.valor,
    data: extraido.data,
    estabelecimento: extraido.estabelecimento,
    descricao: extraido.descricao,
    categoria,
    // O tipo agora é sempre perguntado ao dono (não usamos mais o palpite da IA pra pular a pergunta).
    tipoDespesa: null,
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
    await sendButtons(
      chatId,
      `Registrei um valor de R$ ${extraido.valor.toFixed(2)} mas não tenho certeza — está correto? ` +
        `Toque em Confirmar, ou digite o valor certo.`,
      [{ id: "confirma_valor", title: "✅ Confirmar" }]
    );
    return;
  }

  await perguntarTipo(chatId, despesaId, extraido.valor, categoria);
}

async function perguntarTipo(chatId: string, despesaId: string, valor: number, categoria: CategoriaDespesa): Promise<void> {
  await definirEstado(chatId, { aguardando: "tipo_despesa", despesaId });
  await sendButtons(chatId, `Registrei R$ ${valor.toFixed(2)} (${categoria}). Essa despesa é de:`, TIPO_BOTOES);
}

function botoesRelatorios(abertos: Array<{ id: string; nome: string }>) {
  return abertos
    .slice(0, 2)
    .map((r) => ({ id: `relatorio_${r.id}`, title: r.nome }))
    .concat([{ id: "relatorio_novo", title: "+ Nova viagem" }]);
}

async function concluirComTipo(chatId: string, despesaId: string, tipoDespesa: TipoDespesa): Promise<void> {
  if (tipoDespesa === "viagem") {
    const abertos = await listarRelatoriosAbertos();
    if (abertos.length === 0) {
      // Sem relatório aberto pra escolher — só nesse caso perguntamos o nome digitado.
      await definirEstado(chatId, { aguardando: "nome_relatorio_viagem", despesaId });
      await sendText(chatId, 'Qual o nome dessa viagem? (ex: "Viagem São Paulo")');
    } else {
      await definirEstado(chatId, { aguardando: "relatorio_viagem", despesaId });
      await sendButtons(chatId, "Em qual relatório de viagem lanço essa despesa?", botoesRelatorios(abertos));
    }
    return;
  }

  await perguntarData(chatId, despesaId, tipoDespesa, null);
}

function dataDeHojeISO(): string {
  // "en-CA" formata como YYYY-MM-DD — evita depender do fuso do servidor, que pode não ser o do Brasil.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function formatarDataBR(iso: string): string {
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

function parsearDataDigitada(texto: string): string | null {
  const limpo = texto.trim();
  let m = limpo.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = limpo.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = limpo.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (m) return `${dataDeHojeISO().slice(0, 4)}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

async function perguntarData(
  chatId: string,
  despesaId: string,
  tipoDespesa: TipoDespesa,
  relatorioViagemId: string | null
): Promise<void> {
  await definirEstado(chatId, { aguardando: "data_despesa", despesaId, tipoDespesa, relatorioViagemId });
  const despesa = await buscarDespesa(despesaId);
  const hoje = dataDeHojeISO();
  const botoes: Array<{ id: string; title: string }> = [];
  if (despesa?.data && despesa.data !== hoje) {
    botoes.push({ id: "data_extraida", title: `📅 ${formatarDataBR(despesa.data)}` });
  }
  botoes.push({ id: "data_hoje", title: "📅 Hoje" });
  await sendButtons(chatId, "Qual a data dessa despesa? Toque numa opção ou digite (ex: 15/03/2026).", botoes);
}

async function perguntarTitulo(
  chatId: string,
  despesaId: string,
  tipoDespesa: TipoDespesa,
  relatorioViagemId: string | null
): Promise<void> {
  await definirEstado(chatId, { aguardando: "titulo_despesa", despesaId, tipoDespesa, relatorioViagemId });
  const despesa = await buscarDespesa(despesaId);
  const botoes: Array<{ id: string; title: string }> = [];
  if (despesa?.descricao) {
    botoes.push({ id: "titulo_sugestao", title: `Usar "${despesa.descricao.slice(0, 30)}"` });
  }
  await sendButtons(
    chatId,
    'Qual o título dessa despesa? (ex: "Refeição com líderes") Digite o texto, ou toque na sugestão.',
    botoes
  );
}

async function pedirDescricaoAdicional(
  chatId: string,
  despesaId: string,
  tipoDespesa: TipoDespesa,
  relatorioViagemId: string | null
): Promise<void> {
  await definirEstado(chatId, { aguardando: "descricao_adicional", despesaId, tipoDespesa, relatorioViagemId });
  await sendButtons(
    chatId,
    'Quer adicionar uma descrição? (ex: "Refeição com líderes") Digite o texto, ou toque em Sem descrição.',
    [{ id: "sem_descricao", title: "Sem descrição" }]
  );
}

async function finalizarComDescricao(
  chatId: string,
  despesaId: string,
  tipoDespesa: TipoDespesa,
  relatorioViagemId: string | null,
  descricaoAdicional: string | null
): Promise<void> {
  if (descricaoAdicional) {
    const despesa = await buscarDespesa(despesaId);
    const descricao = despesa?.descricao ? `${despesa.descricao} — ${descricaoAdicional}` : descricaoAdicional;
    await atualizarDespesa(despesaId, { descricao });
  }
  await finalizarDespesa(despesaId, tipoDespesa, relatorioViagemId);
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
    if (respostaId === "relatorio_novo") {
      await definirEstado(chatId, { aguardando: "nome_relatorio_viagem", despesaId: pendencia.despesaId });
      await sendText(chatId, 'Qual o nome dessa viagem? (ex: "Viagem São Paulo")');
      return;
    }
    if (respostaId?.startsWith("relatorio_")) {
      const relatorioId = respostaId.replace("relatorio_", "");
      await perguntarData(chatId, pendencia.despesaId, "viagem", relatorioId);
      return;
    }
    // Resposta digitada em vez de tocar num botão — não cria relatório novo sozinho,
    // pra não duplicar um relatório que já está aberto. Mostra as opções de novo.
    const abertos = await listarRelatoriosAbertos();
    await sendButtons(chatId, "Toque em uma das opções abaixo:", botoesRelatorios(abertos));
    return;
  }

  if (pendencia.aguardando === "nome_relatorio_viagem") {
    if (!respostaTexto) {
      await sendText(chatId, "Qual o nome dessa viagem?");
      return;
    }
    const relatorioId = await criarRelatorioViagem(respostaTexto);
    await perguntarData(chatId, pendencia.despesaId, "viagem", relatorioId);
    return;
  }

  if (pendencia.aguardando === "confirmacao_valor") {
    const despesa = await buscarDespesa(pendencia.despesaId);
    if (!despesa) return;
    const confirmou = respostaId === "confirma_valor" || (!!respostaTexto && /^confirma/i.test(respostaTexto));
    let valorFinal = despesa.valor ?? 0;
    if (!confirmou && respostaTexto) {
      const novoValor = Number(respostaTexto.replace(",", ".").replace(/[^0-9.]/g, ""));
      if (!Number.isNaN(novoValor) && novoValor > 0) {
        valorFinal = novoValor;
        await atualizarDespesa(pendencia.despesaId, { valor: novoValor });
      }
    }
    await perguntarTipo(chatId, pendencia.despesaId, valorFinal, despesa.categoria);
    return;
  }

  if (pendencia.aguardando === "data_despesa") {
    let novaData: string | null = null;
    if (respostaId === "data_hoje") {
      novaData = dataDeHojeISO();
    } else if (respostaId === "data_extraida") {
      const despesa = await buscarDespesa(pendencia.despesaId);
      novaData = despesa?.data ?? dataDeHojeISO();
    } else if (respostaTexto) {
      novaData = parsearDataDigitada(respostaTexto);
      if (!novaData) {
        await sendText(chatId, "Não entendi essa data. Digite no formato 15/03/2026, ou toque numa opção.");
        return;
      }
    } else {
      await sendText(chatId, "Qual a data dessa despesa?");
      return;
    }
    await atualizarDespesa(pendencia.despesaId, { data: novaData });
    await perguntarTitulo(chatId, pendencia.despesaId, pendencia.tipoDespesa, pendencia.relatorioViagemId);
    return;
  }

  if (pendencia.aguardando === "titulo_despesa") {
    let titulo: string | null = null;
    if (respostaId === "titulo_sugestao") {
      const despesa = await buscarDespesa(pendencia.despesaId);
      titulo = despesa?.descricao ?? null;
    } else if (respostaTexto) {
      titulo = respostaTexto;
    }
    if (!titulo) {
      await sendText(chatId, "Qual o título dessa despesa?");
      return;
    }
    await atualizarDespesa(pendencia.despesaId, { descricao: titulo });
    await pedirDescricaoAdicional(chatId, pendencia.despesaId, pendencia.tipoDespesa, pendencia.relatorioViagemId);
    return;
  }

  if (pendencia.aguardando === "descricao_adicional") {
    const descricaoAdicional = respostaId === "sem_descricao" ? null : respostaTexto?.trim() || null;
    await limparEstado(chatId);
    await finalizarComDescricao(chatId, pendencia.despesaId, pendencia.tipoDespesa, pendencia.relatorioViagemId, descricaoAdicional);
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
