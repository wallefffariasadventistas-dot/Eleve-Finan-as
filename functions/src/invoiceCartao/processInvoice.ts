import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { extractInvoiceTransactions, ArquivoFaturaBuffer } from "../ai/invoiceExtractor";
import { CATEGORIAS } from "../ai/expenseExtractor";
import { criarDespesa } from "../firestore/expenses";
import { collections } from "../firestore/db";
import { salvarArquivosFatura } from "../utils/storage";
import { CategoriaDespesa } from "../types";

interface ArquivoFaturaRequest {
  base64: string;
  mimeType: string;
}

interface ProcessarFaturaRequest {
  arquivos: ArquivoFaturaRequest[];
  /** Mês de referência escolhido pelo dono (ex: "2024-09"), só pra rotular a fatura na lista. */
  mesReferencia?: string | null;
}

const MAX_ARQUIVOS = 3;

/**
 * Lê a fatura do cartão de crédito (1 a 3 arquivos, imagem ou PDF) com IA, separa cada
 * transação por categoria e já lança uma despesa pessoal pra cada uma — usado pelo botão
 * "Subir fatura do cartão" na área de Despesas Pessoais do dashboard.
 */
export const processarFaturaCartao = onCall<ProcessarFaturaRequest>(
  { secrets: ["ANTHROPIC_API_KEY"], timeoutSeconds: 300, memory: "512MiB" },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError("unauthenticated", "É preciso estar autenticado no Eleve.");
    }

    const arquivosRequest = req.data.arquivos;
    if (!arquivosRequest || arquivosRequest.length === 0) {
      throw new HttpsError("invalid-argument", "Envie ao menos um arquivo da fatura.");
    }
    if (arquivosRequest.length > MAX_ARQUIVOS) {
      throw new HttpsError("invalid-argument", `Envie no máximo ${MAX_ARQUIVOS} arquivos por fatura.`);
    }

    const mesReferencia = req.data.mesReferencia ?? null;
    const arquivosBuffer: ArquivoFaturaBuffer[] = arquivosRequest.map((a) => ({
      buffer: Buffer.from(a.base64, "base64"),
      mimeType: a.mimeType,
    }));

    const transacoesBrutas = await extractInvoiceTransactions(arquivosBuffer);
    const transacoes = transacoesBrutas
      .filter((t) => typeof t.valor === "number" && Number.isFinite(t.valor) && (t.valor as number) > 0)
      .map((t) => {
        const categoria: CategoriaDespesa = (CATEGORIAS as string[]).includes(t.categoriaSugerida)
          ? t.categoriaSugerida
          : "outros";
        return {
          valor: t.valor as number,
          data: t.data ?? (mesReferencia ? `${mesReferencia}-15` : null),
          estabelecimento: t.estabelecimento,
          descricao: t.descricao || t.estabelecimento || "Despesa da fatura do cartão",
          categoria,
        };
      });

    if (transacoes.length === 0) {
      throw new HttpsError(
        "failed-precondition",
        "Não consegui identificar nenhuma despesa nessa fatura. Confira os arquivos e tente novamente."
      );
    }

    const faturaRef = collections.creditCardInvoices.doc();
    const faturaId = faturaRef.id;
    const caminhosArquivos = await salvarArquivosFatura(faturaId, arquivosBuffer);

    const despesaIds: string[] = [];
    for (const t of transacoes) {
      const id = await criarDespesa({
        valor: t.valor,
        data: t.data,
        estabelecimento: t.estabelecimento,
        descricao: t.descricao,
        categoria: t.categoria,
        tipoDespesa: "pessoal",
        finalizado: true,
        origem: "fatura-cartao",
        relatorioViagemId: null,
        comprovanteStoragePath: null,
        faturaCartaoId: faturaId,
      });
      despesaIds.push(id);
    }

    const porCategoria: Partial<Record<CategoriaDespesa, { total: number; qtd: number }>> = {};
    let totalGeral = 0;
    for (const t of transacoes) {
      if (!porCategoria[t.categoria]) porCategoria[t.categoria] = { total: 0, qtd: 0 };
      porCategoria[t.categoria]!.total += t.valor;
      porCategoria[t.categoria]!.qtd += 1;
      totalGeral += t.valor;
    }

    await faturaRef.set({
      mesReferencia,
      arquivos: caminhosArquivos,
      totalGeral,
      porCategoria,
      despesaIds,
      criadoEm: FieldValue.serverTimestamp(),
    });

    return { faturaId, totalGeral, porCategoria, quantidadeDespesas: despesaIds.length };
  }
);
