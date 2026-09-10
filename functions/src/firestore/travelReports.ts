import { FieldValue } from "firebase-admin/firestore";
import { collections } from "./db";

export interface RelatorioViagem {
  nome: string; // ex: "Viagem São Paulo — Set/2026"
  destino: string | null;
  dataInicio: string | null;
  dataFim: string | null;
  status: "aberto" | "encerrado";
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

export async function encerrarRelatorioViagem(id: string): Promise<void> {
  await collections.travelReports.doc(id).update({ status: "encerrado" });
}
