import { FieldValue } from "firebase-admin/firestore";
import { collections } from "./db";
import { CategoriaDespesa, TipoDespesa } from "../types";

export type OrigemLancamento =
  | "telegram-foto"
  | "telegram-audio"
  | "telegram-texto"
  | "telegram-comprovante"
  | "manual";

export type StatusReembolso = "nao_reembolsavel" | "pendente" | "enviado" | "reembolsado";

export interface Despesa {
  valor: number | null;
  data: string | null; // ISO yyyy-mm-dd
  estabelecimento: string | null;
  descricao: string;
  categoria: CategoriaDespesa;
  tipoDespesa: TipoDespesa | null;
  /** false enquanto o Telegram ainda está perguntando tipo/relatório/valor ao dono. */
  finalizado: boolean;
  reembolsavel: boolean;
  statusReembolso: StatusReembolso;
  relatorioViagemId: string | null;
  origem: OrigemLancamento;
  comprovanteStoragePath: string | null;
  /** Comprovantes além do primeiro, quando várias fotos/PDFs são enviados juntos pra mesma despesa. */
  comprovantesExtras?: string[];
  criadoEm: FirebaseFirestore.FieldValue;
  atualizadoEm: FirebaseFirestore.FieldValue;
}

/** Viagem e departamento são sempre reembolsáveis; despesa pessoal nunca é. */
export function calcularReembolsavel(tipoDespesa: TipoDespesa | null): boolean {
  return tipoDespesa === "viagem" || tipoDespesa === "departamento";
}

export async function criarDespesa(
  dados: Omit<Despesa, "statusReembolso" | "reembolsavel" | "criadoEm" | "atualizadoEm">
): Promise<string> {
  const reembolsavel = calcularReembolsavel(dados.tipoDespesa);
  const doc = await collections.expenses.add({
    ...dados,
    reembolsavel,
    statusReembolso: !dados.finalizado ? "nao_reembolsavel" : reembolsavel ? "pendente" : "nao_reembolsavel",
    criadoEm: FieldValue.serverTimestamp(),
    atualizadoEm: FieldValue.serverTimestamp(),
  });
  return doc.id;
}

/** Recalcula reembolsavel/statusReembolso quando o tipoDespesa é confirmado depois de perguntas. */
export async function finalizarDespesa(id: string, tipoDespesa: TipoDespesa, relatorioViagemId: string | null): Promise<void> {
  const reembolsavel = calcularReembolsavel(tipoDespesa);
  await collections.expenses.doc(id).update({
    tipoDespesa,
    relatorioViagemId,
    finalizado: true,
    reembolsavel,
    statusReembolso: reembolsavel ? "pendente" : "nao_reembolsavel",
    atualizadoEm: FieldValue.serverTimestamp(),
  });
}

export async function atualizarDespesa(id: string, dados: Partial<Despesa>): Promise<void> {
  await collections.expenses.doc(id).update({
    ...dados,
    atualizadoEm: FieldValue.serverTimestamp(),
  });
}

export async function marcarStatusReembolso(ids: string[], status: StatusReembolso): Promise<void> {
  const batch = collections.expenses.firestore.batch();
  for (const id of ids) {
    batch.update(collections.expenses.doc(id), {
      statusReembolso: status,
      atualizadoEm: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
}

/** Apaga uma despesa ainda não finalizada — usado quando o dono cancela o lançamento no meio do fluxo. */
export async function excluirDespesa(id: string): Promise<void> {
  await collections.expenses.doc(id).delete();
}

export async function buscarDespesa(id: string): Promise<(Despesa & { id: string }) | null> {
  const snap = await collections.expenses.doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as Despesa) };
}

export async function listarPendentesDeReembolso(
  tipoDespesa?: TipoDespesa,
  relatorioViagemId?: string
): Promise<Array<Despesa & { id: string }>> {
  let query: FirebaseFirestore.Query = collections.expenses.where("statusReembolso", "==", "pendente");
  if (tipoDespesa) query = query.where("tipoDespesa", "==", tipoDespesa);
  if (relatorioViagemId) query = query.where("relatorioViagemId", "==", relatorioViagemId);
  const snap = await query.get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Despesa) }));
}
