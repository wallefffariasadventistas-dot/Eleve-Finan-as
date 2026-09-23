import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { CategoriaDespesa } from "../types";
import { CATEGORIAS } from "./expenseExtractor";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/** Uma transação/compra individual lida de dentro da fatura do cartão. */
export interface InvoiceTransaction {
  data: string | null; // ISO yyyy-mm-dd
  estabelecimento: string | null;
  descricao: string;
  valor: number | null;
  categoriaSugerida: CategoriaDespesa;
}

const SYSTEM_PROMPT = `Você é o assistente financeiro do sistema Eleve. Você vai receber um ou mais
arquivos (imagem ou PDF) da FATURA de um cartão de crédito — um extrato com várias linhas de
compras. Sua única tarefa é ler TODAS as transações de compra da fatura e devolver APENAS um JSON
válido, sem markdown, sem comentários, no formato:

{
  "transacoes": [
    {
      "data": "YYYY-MM-DD" | null,
      "estabelecimento": string | null,
      "descricao": string,
      "valor": number,
      "categoriaSugerida": ${JSON.stringify(CATEGORIAS)}
    }
  ]
}

Regras:
- Uma entrada por transação/compra listada na fatura — nunca agrupe compras diferentes numa só linha.
- NUNCA inclua como transação: saldo anterior, pagamento da fatura anterior, total a pagar da
  fatura, limite disponível/utilizado, ou qualquer linha que não seja um gasto de fato. Juros,
  IOF e anuidade podem entrar como categoria "outros" quando cobrados como um item da fatura.
- "valor" é o valor da transação em reais, como número positivo (ex: 45.90), sem o símbolo R$.
- "data" é a data da compra (não a data de fechamento/vencimento da fatura), em YYYY-MM-DD,
  quando estiver legível.
- Se vierem vários arquivos/páginas da mesma fatura, junte as transações de todos numa lista só,
  sem duplicar uma transação que apareça repetida em mais de um arquivo.
- Nunca invente valores ou estabelecimentos. Se não conseguir ler uma linha com segurança, pule-a
  em vez de adivinhar.`;

function parseInvoiceResponse(textBlock: { type: string; text?: string } | undefined): InvoiceTransaction[] {
  if (!textBlock || textBlock.type !== "text" || !textBlock.text) {
    throw new Error("Resposta da IA sem conteúdo de texto");
  }
  const semCercaMarkdown = textBlock.text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const parsed = JSON.parse(semCercaMarkdown) as { transacoes?: InvoiceTransaction[] };
  return Array.isArray(parsed.transacoes) ? parsed.transacoes : [];
}

export interface ArquivoFaturaBuffer {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Lê uma ou mais páginas/arquivos (imagem e/ou PDF) da mesma fatura de cartão de crédito e
 * devolve todas as transações identificadas, já com a categoria sugerida pra cada uma. Usa a
 * mesma extensão beta de PDF do `expenseExtractor` quando algum arquivo enviado é PDF.
 */
export async function extractInvoiceTransactions(arquivos: ArquivoFaturaBuffer[]): Promise<InvoiceTransaction[]> {
  const temPdf = arquivos.some((a) => a.mimeType === "application/pdf");
  const content = arquivos.map((arquivo) =>
    arquivo.mimeType === "application/pdf"
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: arquivo.buffer.toString("base64") } }
      : { type: "image" as const, source: { type: "base64" as const, media_type: arquivo.mimeType as "image/jpeg" | "image/png" | "image/webp", data: arquivo.buffer.toString("base64") } }
  );
  content.push({ type: "text" as const, text: `Fatura enviada em ${arquivos.length} arquivo(s).` } as never);

  const response = temPdf
    ? await anthropic.beta.messages.create({
        model: config.anthropic.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        betas: ["pdfs-2024-09-25"],
        messages: [{ role: "user", content: content as never }],
      })
    : await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: content as never }],
      });
  return parseInvoiceResponse(response.content.find((b) => b.type === "text"));
}
