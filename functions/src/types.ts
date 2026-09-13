/** Campos estruturados que a IA extrai de qualquer origem (foto, áudio, texto, comprovante). */
export interface ExtractedExpense {
  valor: number | null;
  data: string | null; // ISO yyyy-mm-dd, quando identificável no documento/fala
  estabelecimento: string | null;
  descricao: string;
  categoriaSugerida: CategoriaDespesa;
  tipoDespesaSugerido: TipoDespesa | null;
  confiancaBaixa: boolean; // true quando a IA não tem certeza do valor/categoria
}

export type TipoDespesa = "viagem" | "departamento" | "pessoal";

export type CategoriaDespesa =
  | "combustivel"
  | "hospedagem"
  | "alimentacao"
  | "transporte"
  | "carro_alugado"
  | "material"
  | "servicos"
  | "outros";
