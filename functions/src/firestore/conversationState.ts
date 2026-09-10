import { FieldValue } from "firebase-admin/firestore";
import { collections } from "./db";

/**
 * O que falta perguntar ao usuário antes de considerar uma despesa "lançada".
 * O doc id da coleção é o próprio número de WhatsApp do dono (só ele lança despesas).
 */
export type Pendencia =
  | { aguardando: "tipo_despesa"; despesaId: string }
  | { aguardando: "relatorio_viagem"; despesaId: string }
  | { aguardando: "confirmacao_valor"; despesaId: string }
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
