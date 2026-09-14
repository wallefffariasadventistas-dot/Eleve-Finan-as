import { FieldValue } from "firebase-admin/firestore";
import { collections, db } from "./db";
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
  /** Presente só quando vários comprovantes foram enviados juntos — um item por comprovante, pra listar antes do total. */
  itens?: Array<{ descricao: string; valor: number }>;
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
  | { aguardando: "processando_ia"; mediaGroupId: string | null }
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

/**
 * Tenta "travar" a conversa pra começar a processar um novo comprovante com a IA (que demora
 * alguns segundos): evita que dois comprovantes mandados quase juntos (mas fora do mesmo álbum
 * do Telegram) virem duas despesas em paralelo brigando pelo mesmo estado de conversa.
 * Cada mensagem de um MESMO álbum pode "entrar" na trava já aberta por outra mensagem do
 * mesmo álbum (mediaGroupId igual); qualquer outro envio nesse meio tempo é recusado.
 */
export async function tentarIniciarProcessamento(chatId: string, mediaGroupId: string | null): Promise<boolean> {
  const ref = collections.conversationState.doc(chatId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const atual = snap.exists ? (snap.data() as EstadoConversa).pendencia : null;

    if (atual && atual.aguardando === "processando_ia" && mediaGroupId !== null && atual.mediaGroupId === mediaGroupId) {
      return true; // outra mensagem do mesmo álbum já travou — pode prosseguir junto
    }
    if (atual) {
      return false; // ocupado com outro lançamento em andamento
    }

    tx.set(ref, {
      pendencia: { aguardando: "processando_ia", mediaGroupId },
      atualizadoEm: FieldValue.serverTimestamp(),
    });
    return true;
  });
}
