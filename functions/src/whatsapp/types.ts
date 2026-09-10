export type WhatsAppMediaType = "image" | "audio" | "document" | "video";

export interface WhatsAppIncomingMessage {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | WhatsAppMediaType | "interactive" | "button";
  text?: { body: string };
  image?: { id: string; mime_type: string; caption?: string };
  audio?: { id: string; mime_type: string };
  document?: { id: string; mime_type: string; filename?: string; caption?: string };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
}

export interface WhatsAppWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: WhatsAppIncomingMessage[];
        contacts?: Array<{ profile?: { name?: string }; wa_id: string }>;
      };
    }>;
  }>;
}

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
