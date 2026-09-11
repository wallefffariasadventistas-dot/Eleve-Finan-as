import { FieldValue } from "firebase-admin/firestore";
import { collections } from "./db";

export interface RelatorioViagem {
  nome: string; // ex: "Viagem São Paulo — Set/2026"
  destino: string | null;
  dataInicio: string | null;
  dataFim: string | null;
  // "aberto": aceita novos lançamentos. "enviado"/"pago": já mandado para reembolso ou
  // já reembolsado — nenhum lançamento novo pode ser adicionado a partir daí.
  status: "aberto" | "enviado" | "pago";
  criadoEm: FirebaseFirestore.FieldValue;
}

export async function criarRelatorioViagem(nome: string, destino?: string): Promise<string> {
  const doc = await collections.travelReports.add({
    nome,
    destino: destino ?? null,
    dataInicio: null,
    dataFim: null,
    status: "aberto",
    criadoEm: FieldValue.serverTimestamp(),
  } satisfies RelatorioViagem);
  return doc.id;
}

export async function listarRelatoriosAbertos(): Promise<Array<RelatorioViagem & { id: string }>> {
  const snap = await collections.travelReports.where("status", "==", "aberto").get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as RelatorioViagem) }));
}
