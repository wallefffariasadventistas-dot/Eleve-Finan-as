import { FieldValue } from "firebase-admin/firestore";
import { collections } from "./db";
import { CategoriaDespesa, TipoDespesa } from "../types";
import { OrigemLancamento } from "./expenses";

/** Dados já extraídos pela IA, guardados enquanto se espera o dono confirmar o lançamento. */
export interface ResumoDespesaPendente {
  valor: number;
  data: string | null;
  estabelecimento: string | null;
  descricao: string;
  categoria: CategoriaDespesa;
  confiancaBaixa: boolean;
}

/** Referência a um arquivo do Telegram ainda não baixado (baixa de novo só se confirmado). */
export interface ArquivoPendente {
  fileId: string;
  mimeType?: string;
}

/**
 * O que falta perguntar ao usuário antes de considerar uma despesa "lançada".
 * O doc id da coleção é o próprio chat ID do Telegram do dono (só ele lança despesas).
 */
export type Pendencia =
  | { aguardando: "confirmar_lancamento"; resumo: ResumoDespesaPendente; arquivos: ArquivoPendente[]; origem: OrigemLancamento }
  | { aguardando: "tipo_despesa"; despesaId: string }
  | { aguardando: "relatorio_viagem"; despesaId: string }
  | { aguardando: "nome_relatorio_viagem"; despesaId: string }
  | { aguardando: "confirmacao_valor"; despesaId: string }
  | { aguardando: "data_despesa"; despesaId: string; tipoDespesa: TipoDespesa; relatorioViagemId: string | null }
  | { aguardando: "titulo_despesa"; despesaId: string; tipoDespesa: TipoDespesa; relatorioViagemId: string | null }
  | { aguardando: "descricao_adicional"; despesaId: string; tipoDespesa: TipoDespesa; relatorioViagemId: string | null }
  | null;

export interface EstadoConversa {
  pendencia: Pendencia;
  atualizadoEm: FirebaseFirestore.FieldValue;
}

export async function obterEstado(numero: string): Promise<Pendencia> {
  const snap = await collections.conversationState.doc(numero).get();
  if (!snap.exists) return null;
  return (snap.data() as EstadoConversa).pendencia;
}

export async function definirEstado(numero: string, pendencia: Pendencia): Promise<void> {
  await collections.conversationState.doc(numero).set({
    pendencia,
    atualizadoEm: FieldValue.serverTimestamp(),
  });
}

export async function limparEstado(numero: string): Promise<void> {
  await definirEstado(numero, null);
}
