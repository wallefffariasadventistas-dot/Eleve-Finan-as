import { config } from "../config";
import { sendButtons, sendText, downloadMedia, answerCallback } from "./client";
import { TelegramCallbackQuery, TelegramMessage, TelegramUpdate } from "./types";
import { extractFromImage, extractFromPdf, extractFromText } from "../ai/expenseExtractor";
import { transcribeAudio } from "../ai/audioTranscriber";
import { copiarComprovantesParaNotaFixa, excluirComprovantes, salvarComprovante } from "../utils/storage";
import {
  atualizarDespesa,
  buscarDespesa,
  criarDespesa,
  excluirDespesa,
  finalizarDespesa,
  OrigemLancamento,
} from "../firestore/expenses";
import {
  atualizarNotaFixa,
  criarNotaFixa,
  criarRelatorioFixo,
  listarRelatoriosFixosRecentes,
  nomeMesAtual,
} from "../firestore/fixedReports";
import { criarRelatorioViagem, listarRelatoriosAbertos } from "../firestore/travelReports";
import {
  ArquivoPendente,
  definirEstado,
  limparEstado,
  obterEstado,
  Pendencia,
  ResumoDespesaPendente,
  tentarIniciarProcessamento,
} from "../firestore/conversationState";
import { ArquivoGrupo, registrarArquivoEAguardarSeUltimo } from "../firestore/mediaGroups";
import { CategoriaDespesa, ExtractedExpense, TipoDespesa } from "../types";

const TIPO_BOTOES: Array<{ id: `tipo_${TipoDespesa}`; title: string }> = [
  { id: "tipo_viagem", title: "Viagem" },
  { id: "tipo_departamento", title: "Departamento" },
  { id: "tipo_pessoal", title: "Pessoal" },
];

// Mesmas opções de tipo, mais a opção de guardar o comprovante no Relatório Fixo Mensal em vez
// de lançar como despesa (não é um TipoDespesa — vai pra uma coleção separada, "notasFixas").
const TIPO_BOTOES_COM_FIXO = [...TIPO_BOTOES, { id: "lancar_fixo", title: "📋 Relatório Fixo Mensal" }];

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
  // Botão de uma pergunta antiga, tocado enquanto a IA já está analisando outro comprovante —
  // ignora (não há resposta válida a dar nesse estado).
  if (!pendencia || pendencia.aguardando === "processando_ia") return;
  await tratarResposta(chatId, { respostaId: callback.data }, pendencia);
}

async function processarMensagem(msg: TelegramMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  if (chatId !== config.telegram.ownerChatId) {
    // Automação é de uso pessoal: qualquer outro chat é ignorado silenciosamente.
    return;
  }

  const pendencia = await obterEstado(chatId);
  // "processando_ia" é uma trava interna (IA ainda analisando um comprovante anterior), não
  // uma pergunta esperando resposta — só as demais pendências tratam a mensagem como resposta.
  if (pendencia && pendencia.aguardando !== "processando_ia") {
    if (!msg.text && (msg.photo?.length || msg.document || msg.voice)) {
      // Comprovante chegando enquanto ainda esperamos resposta de uma pergunta anterior (ex:
      // uma foto de álbum que demorou mais pra subir) — não dá pra processar agora, e tratar
      // como se fosse texto de resposta só confundiria (e perderia o arquivo sem avisar).
      await sendText(
        chatId,
        "Ainda estou esperando sua resposta da pergunta anterior. Responda ela primeiro — se esse arquivo era da mesma despesa, cancele e mande os comprovantes juntos de novo."
      );
      return;
    }
    await tratarResposta(chatId, { respostaTexto: msg.text?.trim() }, pendencia);
    return;
  }

  const avisarOcupado = () =>
    sendText(chatId, "Ainda estou processando o comprovante anterior, me dá só um instante 🙂");

  // Se algo quebrar no meio da análise da IA, libera a trava "processando_ia" antes de propagar
  // o erro — senão o bot fica travado achando que ainda está ocupado até alguém mexer no Firestore.
  const comTravaLiberadaNoErro = async (tarefa: () => Promise<void>): Promise<void> => {
    try {
      await tarefa();
    } catch (err) {
      await limparEstado(chatId).catch(() => {});
      throw err;
    }
  };

  if (msg.media_group_id && (msg.photo?.length || msg.document)) {
    // Cada foto de um álbum chega como uma mensagem separada — a trava usa o mediaGroupId
    // pra deixar todas elas passarem juntas, mesmo que outra já tenha travado primeiro.
    if (!(await tentarIniciarProcessamento(chatId, msg.media_group_id))) {
      await avisarOcupado();
      return;
    }
    await comTravaLiberadaNoErro(() => processarArquivoAgrupado(chatId, msg, msg.media_group_id!));
    return;
  }

  if (msg.photo && msg.photo.length > 0) {
    if (!(await tentarIniciarProcessamento(chatId, null))) {
      await avisarOcupado();
      return;
    }
    await comTravaLiberadaNoErro(async () => {
      const maior = msg.photo!.reduce((a, b) => (b.width > a.width ? b : a));
      const { buffer, mimeType } = await downloadMedia(maior.file_id);
      const extraido = await extractFromImage(buffer, mimeType, msg.caption);
      await lancarDespesa(chatId, extraido, maior.file_id, mimeType, "telegram-foto");
    });
    return;
  }

  if (msg.document) {
    if (!(await tentarIniciarProcessamento(chatId, null))) {
      await avisarOcupado();
      return;
    }
    await comTravaLiberadaNoErro(async () => {
      const documento = msg.document!;
      const { buffer, mimeType: mimeBaixado } = await downloadMedia(documento.file_id);
      const mimeType = documento.mime_type ?? mimeBaixado;
      const extraido =
        mimeType === "application/pdf"
          ? await extractFromPdf(buffer, msg.caption)
          : await extractFromImage(buffer, mimeType, msg.caption);
      await lancarDespesa(chatId, extraido, documento.file_id, mimeType, "telegram-comprovante");
    });
    return;
  }

  if (msg.voice) {
    if (!(await tentarIniciarProcessamento(chatId, null))) {
      await avisarOcupado();
      return;
    }
    await comTravaLiberadaNoErro(async () => {
      const voz = msg.voice!;
      const { buffer, mimeType } = await downloadMedia(voz.file_id);
      const transcricao = await transcribeAudio(buffer);
      const extraido = await extractFromText(transcricao);
      await lancarDespesa(chatId, extraido, voz.file_id, mimeType, "telegram-audio");
    });
    return;
  }

  if (msg.text) {
    if (!(await tentarIniciarProcessamento(chatId, null))) {
      await avisarOcupado();
      return;
    }
    await comTravaLiberadaNoErro(() => tratarTexto(chatId, msg.text!));
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
  fileId: string | null,
  mimeType: string | null,
  origem: OrigemLancamento
): Promise<void> {
  if (extraido.valor === null) {
    await limparEstado(chatId); // libera a trava de "processando_ia" — senão o bot fica achando que ainda está ocupado
    await sendText(
      chatId,
      "Não consegui identificar o valor dessa despesa. Pode me enviar de novo ou escrever o valor?"
    );
    return;
  }

  const categoria: CategoriaDespesa = extraido.categoriaSugerida ?? "outros";
  const resumo: ResumoDespesaPendente = {
    valor: extraido.valor,
    data: extraido.data,
    estabelecimento: extraido.estabelecimento,
    descricao: extraido.descricao,
    categoria,
    confiancaBaixa: extraido.confiancaBaixa,
  };
  const arquivos: ArquivoPendente[] = fileId && mimeType ? [{ fileId, mimeType }] : [];
  await confirmarAntesDeRegistrar(chatId, resumo, arquivos, origem);
}

/**
 * Mostra um resumo do que a IA leu e espera o dono tocar em Continuar ou Cancelar antes de
 * criar a despesa de fato — dá uma chance de desistir se percebeu que mandou o comprovante
 * errado. Os arquivos ainda não são baixados de novo aqui: só o file_id do Telegram é
 * guardado, e o download real só acontece se o lançamento for confirmado.
 */
async function confirmarAntesDeRegistrar(
  chatId: string,
  resumo: ResumoDespesaPendente,
  arquivos: ArquivoPendente[],
  origem: OrigemLancamento
): Promise<void> {
  await definirEstado(chatId, { aguardando: "confirmar_lancamento", resumo, arquivos, origem });
  const detalhes = [resumo.estabelecimento, resumo.data ? formatarDataBR(resumo.data) : null].filter(Boolean).join(" · ");

  const mensagem =
    resumo.itens && resumo.itens.length > 1
      ? `Encontrei ${resumo.itens.length} comprovantes:\n` +
        resumo.itens.map((item) => `${item.descricao}: R$ ${item.valor.toFixed(2)}`).join("\n") +
        `\n\nTotal: R$ ${resumo.valor.toFixed(2)}${detalhes ? ` (${detalhes})` : ""}\n\nDeseja registrar o total de R$ ${resumo.valor.toFixed(2)}?`
      : `Encontrei: R$ ${resumo.valor.toFixed(2)}${detalhes ? ` (${detalhes})` : ""}\n${resumo.descricao}\n\nQuer registrar essa despesa?`;

  await sendButtons(chatId, mensagem, [
    { id: "confirmar_lancamento_sim", title: "✅ Continuar" },
    { id: "confirmar_lancamento_nao", title: "❌ Cancelar" },
  ]);
}

/**
 * Reúne cada foto de um álbum enviado junto no Telegram: cada mensagem chama isso, mas só a
 * última (depois de uma pequena espera sem novas chegadas) processa o grupo inteiro de uma vez.
 */
async function processarArquivoAgrupado(chatId: string, msg: TelegramMessage, mediaGroupId: string): Promise<void> {
  let arquivo: ArquivoGrupo;
  if (msg.photo && msg.photo.length > 0) {
    const maior = msg.photo.reduce((a, b) => (b.width > a.width ? b : a));
    arquivo = { fileId: maior.file_id, tipo: "photo" };
  } else if (msg.document) {
    arquivo = { fileId: msg.document.file_id, tipo: "document" };
    if (msg.document.mime_type) arquivo.mimeType = msg.document.mime_type;
  } else {
    return;
  }
  if (msg.caption) arquivo.caption = msg.caption;

  const arquivos = await registrarArquivoEAguardarSeUltimo(mediaGroupId, chatId, arquivo);
  if (!arquivos) return; // não foi a última mensagem do álbum — quem processa é outra invocação

  await lancarDespesaMultipla(chatId, arquivos);
}

/** Lê cada comprovante do álbum com a IA, soma os valores e lança tudo como UMA despesa só. */
async function lancarDespesaMultipla(chatId: string, arquivosGrupo: ArquivoGrupo[]): Promise<void> {
  const extraidos: ExtractedExpense[] = [];
  // Fotos do Telegram não vêm com mime_type (só documentos) — guarda o tipo já resolvido
  // (pela extensão do arquivo baixado) pra não gravar "undefined" no Firestore depois.
  const mimeTypesResolvidos: string[] = [];

  for (const arq of arquivosGrupo) {
    const { buffer, mimeType: mimeBaixado } = await downloadMedia(arq.fileId);
    const mimeType = arq.mimeType ?? mimeBaixado;
    mimeTypesResolvidos.push(mimeType);
    const extraido =
      mimeType === "application/pdf"
        ? await extractFromPdf(buffer, arq.caption)
        : await extractFromImage(buffer, mimeType, arq.caption);
    extraidos.push(extraido);
  }

  const comValor = extraidos.filter((e) => e.valor !== null);
  if (comValor.length === 0) {
    await limparEstado(chatId); // libera a trava de "processando_ia" — senão o bot fica achando que ainda está ocupado
    await sendText(chatId, "Não consegui identificar o valor em nenhum dos comprovantes enviados. Pode mandar de novo?");
    return;
  }

  const valorTotal = comValor.reduce((soma, e) => soma + (e.valor ?? 0), 0);
  const confiancaBaixa = comValor.length !== extraidos.length || comValor.some((e) => e.confiancaBaixa);
  const primeiro = comValor[0];
  const categoria: CategoriaDespesa = primeiro.categoriaSugerida ?? "outros";
  const descricao =
    extraidos.length > 1 ? `${primeiro.descricao} (+ ${extraidos.length - 1} comprovante(s))` : primeiro.descricao;
  const temFoto = arquivosGrupo.some((a) => a.tipo === "photo");

  const resumo: ResumoDespesaPendente = {
    valor: valorTotal,
    data: primeiro.data,
    estabelecimento: primeiro.estabelecimento,
    descricao,
    categoria,
    confiancaBaixa,
    ...(comValor.length > 1
      ? { itens: comValor.map((e) => ({ descricao: e.descricao, valor: e.valor as number })) }
      : {}),
  };
  const arquivosPendentes: ArquivoPendente[] = arquivosGrupo.map((a, i) => ({ fileId: a.fileId, mimeType: mimeTypesResolvidos[i] }));
  await confirmarAntesDeRegistrar(chatId, resumo, arquivosPendentes, temFoto ? "telegram-foto" : "telegram-comprovante");
}

async function criarDespesaComArquivos(
  chatId: string,
  dados: ResumoDespesaPendente,
  arquivos: Array<{ buffer: Buffer; mimeType: string }>,
  origem: OrigemLancamento
): Promise<void> {
  const despesaId = await criarDespesa({
    valor: dados.valor,
    data: dados.data,
    estabelecimento: dados.estabelecimento,
    descricao: dados.descricao,
    categoria: dados.categoria,
    // O tipo agora é sempre perguntado ao dono (não usamos mais o palpite da IA pra pular a pergunta).
    tipoDespesa: null,
    finalizado: false,
    relatorioViagemId: null,
    origem,
    comprovanteStoragePath: null,
  });

  if (arquivos.length > 0) {
    const caminhos: string[] = [];
    for (let i = 0; i < arquivos.length; i++) {
      const sufixo = i === 0 ? "" : `-${i + 1}`;
      const path = await salvarComprovante(despesaId, arquivos[i].buffer, arquivos[i].mimeType, sufixo);
      caminhos.push(path);
    }
    await atualizarDespesa(despesaId, {
      comprovanteStoragePath: caminhos[0],
      ...(caminhos.length > 1 ? { comprovantesExtras: caminhos.slice(1) } : {}),
    });
  }

  if (dados.confiancaBaixa) {
    await definirEstado(chatId, { aguardando: "confirmacao_valor", despesaId });
    const rotuloValor =
      arquivos.length > 1
        ? `Registrei um total de R$ ${dados.valor.toFixed(2)} somando ${arquivos.length} comprovantes, mas não tenho certeza de todos os valores`
        : `Registrei um valor de R$ ${dados.valor.toFixed(2)} mas não tenho certeza`;
    await sendButtons(chatId, `${rotuloValor} — está correto? Toque em Confirmar, ou digite o valor certo.`, [
      { id: "confirma_valor", title: "✅ Confirmar" },
    ]);
    return;
  }

  await perguntarTipo(chatId, despesaId, dados.valor, dados.categoria);
}

async function perguntarTipo(chatId: string, despesaId: string, valor: number, categoria: CategoriaDespesa): Promise<void> {
  await definirEstado(chatId, { aguardando: "tipo_despesa", despesaId });
  await sendButtons(chatId, `Registrei R$ ${valor.toFixed(2)} (${categoria}). Essa despesa é de:`, TIPO_BOTOES_COM_FIXO);
}

function botoesRelatoriosFixos(recentes: Array<{ id: string; nome: string }>) {
  return recentes
    .map((r) => ({ id: `relatoriofixo_${r.id}`, title: r.nome }))
    .concat([{ id: "relatoriofixo_novo", title: `+ ${nomeMesAtual()}` }]);
}

async function perguntarRelatorioFixo(chatId: string, despesaId: string): Promise<void> {
  await definirEstado(chatId, { aguardando: "relatorio_fixo", despesaId });
  const recentes = await listarRelatoriosFixosRecentes();
  await sendButtons(chatId, "Em qual relatório fixo mensal eu guardo esse comprovante?", botoesRelatoriosFixos(recentes));
}

/**
 * Quando o dono escolhe "Relatório Fixo Mensal" em vez de Viagem/Departamento/Pessoal: a despesa
 * já tinha sido criada (pra permitir perguntar o valor/tipo normalmente) — aqui ela vira uma nota
 * fixa na coleção separada, os comprovantes são copiados pra pasta de notas fixas, e a despesa
 * original (com seus comprovantes) é apagada.
 */
async function moverDespesaParaRelatorioFixo(chatId: string, despesaId: string, relatorioFixoId: string): Promise<void> {
  await limparEstado(chatId);
  const despesa = await buscarDespesa(despesaId);
  if (!despesa) return;

  const notaId = await criarNotaFixa({
    relatorioFixoId,
    data: despesa.data,
    valor: despesa.valor,
    descricao: despesa.descricao,
  });

  const caminhosAntigos = [despesa.comprovanteStoragePath, ...(despesa.comprovantesExtras ?? [])].filter(
    (p): p is string => !!p
  );
  if (caminhosAntigos.length > 0) {
    const novosCaminhos = await copiarComprovantesParaNotaFixa(notaId, caminhosAntigos);
    await atualizarNotaFixa(notaId, {
      comprovanteStoragePath: novosCaminhos[0],
      ...(novosCaminhos.length > 1 ? { comprovantesExtras: novosCaminhos.slice(1) } : {}),
    });
  }

  await excluirDespesa(despesaId);
  await excluirComprovantes(despesaId);

  await sendText(chatId, "Guardado no relatório fixo mensal ✅");
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
  await sendButtons(chatId, "Qual a data dessa despesa? Toque numa opção.", botoes);
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

  // "cancelar" digitado cancela o lançamento em qualquer etapa do fluxo, não só na confirmação
  // inicial. Exige a palavra exata (não só o prefixo) pra não disparar sozinho quando o texto
  // digitado no título/descrição começa com "cancela..." (ex: "Cancelamento de reserva").
  const textoCancelar = respostaTexto?.trim().toLowerCase();
  if (textoCancelar === "cancela" || textoCancelar === "cancelar") {
    await limparEstado(chatId);
    if (pendencia.aguardando !== "confirmar_lancamento" && pendencia.aguardando !== "processando_ia") {
      await excluirDespesa(pendencia.despesaId);
      await excluirComprovantes(pendencia.despesaId);
    }
    await sendText(chatId, "Cancelado. Nenhuma despesa foi registrada.");
    return;
  }

  if (pendencia.aguardando === "confirmar_lancamento") {
    const cancelou = respostaId === "confirmar_lancamento_nao" || (!!respostaTexto && /^(n[ãa]o|cancela)/i.test(respostaTexto));
    if (cancelou) {
      await limparEstado(chatId);
      await sendText(chatId, "Cancelado. Nenhuma despesa foi registrada.");
      return;
    }
    const confirmou =
      respostaId === "confirmar_lancamento_sim" || (!!respostaTexto && /^(sim|confirma|continua|ok\b|certo)/i.test(respostaTexto));
    if (confirmou) {
      await limparEstado(chatId);
      const arquivosBaixados: Array<{ buffer: Buffer; mimeType: string }> = [];
      for (const arq of pendencia.arquivos) {
        const { buffer, mimeType: mimeBaixado } = await downloadMedia(arq.fileId);
        arquivosBaixados.push({ buffer, mimeType: arq.mimeType ?? mimeBaixado });
      }
      await criarDespesaComArquivos(chatId, pendencia.resumo, arquivosBaixados, pendencia.origem);
      return;
    }
    await sendButtons(chatId, "Não entendi. Quer registrar essa despesa?", [
      { id: "confirmar_lancamento_sim", title: "✅ Continuar" },
      { id: "confirmar_lancamento_nao", title: "❌ Cancelar" },
    ]);
    return;
  }

  if (pendencia.aguardando === "tipo_despesa") {
    const quisRelatorioFixo = respostaId === "lancar_fixo" || (!!respostaTexto && /^fixo/i.test(respostaTexto));
    if (quisRelatorioFixo) {
      await perguntarRelatorioFixo(chatId, pendencia.despesaId);
      return;
    }
    const tipo = (respostaId?.replace("tipo_", "") ?? mapearTipoPorTexto(respostaTexto)) as TipoDespesa | null;
    if (!tipo) {
      await sendButtons(chatId, "Não entendi. Essa despesa é de:", TIPO_BOTOES_COM_FIXO);
      return;
    }
    await limparEstado(chatId);
    await concluirComTipo(chatId, pendencia.despesaId, tipo);
    return;
  }

  if (pendencia.aguardando === "relatorio_fixo") {
    let relatorioFixoId: string;
    if (respostaId === "relatoriofixo_novo") {
      relatorioFixoId = await criarRelatorioFixo(nomeMesAtual());
    } else if (respostaId?.startsWith("relatoriofixo_")) {
      relatorioFixoId = respostaId.replace("relatoriofixo_", "");
    } else {
      const recentes = await listarRelatoriosFixosRecentes();
      await sendButtons(chatId, "Toque em uma das opções abaixo:", botoesRelatoriosFixos(recentes));
      return;
    }
    await moverDespesaParaRelatorioFixo(chatId, pendencia.despesaId, relatorioFixoId);
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
    } else {
      // Só botões nessa pergunta — reenvia as opções em vez de tentar interpretar texto digitado.
      await perguntarData(chatId, pendencia.despesaId, pendencia.tipoDespesa, pendencia.relatorioViagemId);
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
