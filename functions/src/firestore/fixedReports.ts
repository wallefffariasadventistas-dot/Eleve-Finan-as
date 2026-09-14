import { FieldValue } from "firebase-admin/firestore";
import { collections } from "./db";

export interface RelatorioFixo {
  nome: string;
  criadoEm: FirebaseFirestore.FieldValue;
}

export interface NotaFixa {
  relatorioFixoId: string;
  data: string | null;
  valor: number | null;
  descricao: string | null;
  comprovanteStoragePath: string | null;
  /** Comprovantes além do primeiro, quando várias fotos/PDFs são enviados juntos pelo Telegram. */
  comprovantesExtras?: string[];
  criadoEm: FirebaseFirestore.FieldValue;
  atualizadoEm: FirebaseFirestore.FieldValue;
}

const MESES_PT = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
];

/** Mesmo padrão de nome usado no dashboard ao criar um relatório fixo (ex: "Setembro 2026"). */
export function nomeMesAtual(): string {
  const hoje = new Date();
  return `${MESES_PT[hoje.getMonth()]} ${hoje.getFullYear()}`;
}

export async function listarRelatoriosFixosRecentes(limite = 2): Promise<Array<{ id: string; nome: string }>> {
  const snap = await collections.fixedReports.orderBy("criadoEm", "desc").limit(limite).get();
  return snap.docs.map((d) => ({ id: d.id, nome: (d.data() as RelatorioFixo).nome }));
}

export async function criarRelatorioFixo(nome: string): Promise<string> {
  const doc = await collections.fixedReports.add({ nome, criadoEm: FieldValue.serverTimestamp() });
  return doc.id;
}

export async function criarNotaFixa(dados: {
  relatorioFixoId: string;
  data: string | null;
  valor: number | null;
  descricao: string | null;
}): Promise<string> {
  const doc = await collections.fixedNotes.add({
    ...dados,
    comprovanteStoragePath: null,
    criadoEm: FieldValue.serverTimestamp(),
    atualizadoEm: FieldValue.serverTimestamp(),
  });
  return doc.id;
}

export async function atualizarNotaFixa(id: string, dados: Partial<NotaFixa>): Promise<void> {
  await collections.fixedNotes.doc(id).update({
    ...dados,
    atualizadoEm: FieldValue.serverTimestamp(),
  });
}
