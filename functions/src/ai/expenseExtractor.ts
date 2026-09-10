import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { CategoriaDespesa, ExtractedExpense, TipoDespesa } from "../whatsapp/types";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const CATEGORIAS: CategoriaDespesa[] = [
  "combustivel",
  "hospedagem",
  "alimentacao",
  "transporte",
  "carro_alugado",
  "material",
  "servicos",
  "outros",
];

const TIPOS: TipoDespesa[] = ["viagem", "departamento", "pessoal"];

const SYSTEM_PROMPT = `Você é o assistente financeiro do sistema Eleve. Sua única tarefa é ler o
conteúdo enviado (nota fiscal, recibo, comprovante de cartão/Pix, ou uma descrição em texto/fala
de um gasto) e devolver APENAS um JSON válido, sem markdown, sem comentários, no formato:

{
  "valor": number | null,
  "data": "YYYY-MM-DD" | null,
  "estabelecimento": string | null,
  "descricao": string,
  "categoriaSugerida": ${JSON.stringify(CATEGORIAS)},
  "tipoDespesaSugerido": ${JSON.stringify(TIPOS)} | null,
  "confiancaBaixa": boolean
}

Regras:
- "valor" é o total pago, em reais, como número (ex: 45.90). Nunca inclua o símbolo R$.
- "data" é a data da despesa/documento, não a data de hoje, quando estiver visível.
- "tipoDespesaSugerido" só deve ser preenchido quando o próprio texto disser explicitamente
  ("despesa pessoal", "isso é da viagem", "lança no departamento" etc). Caso contrário, null.
- "confiancaBaixa" = true sempre que o valor não estiver legível/claro ou o documento estiver
  incompleto/borrado — isso faz o sistema confirmar com o usuário antes de lançar.
- Nunca invente valores. Se não souber, use null.`;

function parseJsonResponse(textBlock: { type: string; text?: string } | undefined): ExtractedExpense {
  if (!textBlock || textBlock.type !== "text" || !textBlock.text) {
    throw new Error("Resposta da IA sem conteúdo de texto");
  }
  return JSON.parse(textBlock.text) as ExtractedExpense;
}

async function extractFromContent(
  content: Anthropic.MessageCreateParams["messages"][number]["content"]
): Promise<ExtractedExpense> {
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });
  return parseJsonResponse(response.content.find((b) => b.type === "text"));
}

/**
 * O suporte a PDF ("document" content block) ainda está no namespace beta do SDK
 * (@anthropic-ai/sdk 0.32.x) — por isso usa `anthropic.beta.messages.create` em vez de
 * `anthropic.messages.create`. Quando o SDK promover PDFs para a API estável, isso pode
 * virar uma chamada normal como as demais.
 */
async function extractFromPdfContent(pdfBase64: string, caption?: string): Promise<ExtractedExpense> {
  const response = await anthropic.beta.messages.create({
    model: config.anthropic.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    betas: ["pdfs-2024-09-25"],
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
          { type: "text", text: caption ? `Legenda enviada junto: "${caption}"` : "Sem legenda." },
        ],
      },
    ],
  });
  return parseJsonResponse(response.content.find((b) => b.type === "text"));
}

/** Extrai dados estruturados de uma foto de nota/recibo/comprovante. */
export async function extractFromImage(
  imageBuffer: Buffer,
  mimeType: string,
  caption?: string
): Promise<ExtractedExpense> {
  return extractFromContent([
    {
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType as "image/jpeg" | "image/png" | "image/webp",
        data: imageBuffer.toString("base64"),
      },
    },
    { type: "text", text: caption ? `Legenda enviada junto: "${caption}"` : "Sem legenda." },
  ]);
}

/** Extrai dados estruturados de um PDF de comprovante (ex: fatura, recibo digital). */
export async function extractFromPdf(pdfBuffer: Buffer, caption?: string): Promise<ExtractedExpense> {
  return extractFromPdfContent(pdfBuffer.toString("base64"), caption);
}

/** Extrai dados estruturados de texto livre (digitado ou transcrito de áudio). */
export async function extractFromText(text: string): Promise<ExtractedExpense> {
  return extractFromContent([{ type: "text", text }]);
}
