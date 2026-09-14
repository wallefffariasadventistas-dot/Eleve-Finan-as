import { collections } from "./db";

export interface ConfiguracoesReembolso {
  banco: string;
  contaReembolso: string;
  chavePix: string;
  centroCusto: string;
}

/** Dados fixos preenchidos uma vez no dashboard (Área Reembolso) e reaproveitados em todo e-mail. */
export async function obterConfiguracoesReembolso(): Promise<ConfiguracoesReembolso> {
  const snap = await collections.settings.doc("reembolso").get();
  const dados = snap.exists ? (snap.data() as Partial<ConfiguracoesReembolso>) : {};
  return {
    banco: dados.banco ?? "",
    contaReembolso: dados.contaReembolso ?? "",
    chavePix: dados.chavePix ?? "",
    centroCusto: dados.centroCusto ?? "",
  };
}
