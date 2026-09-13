import { onCall, HttpsError } from "firebase-functions/v2/https";
import { extractFromImage, extractFromPdf } from "../ai/expenseExtractor";

interface ExtrairValorNotaRequest {
  base64: string;
  mimeType: string;
}

/**
 * Lê uma nota/cupom/recibo enviado manualmente pelo dashboard e devolve o valor (e outros
 * dados) detectados pela IA — mesma extração já usada no fluxo do Telegram, só que aqui é
 * chamada sob demanda pelo botão "Detectar com IA" em vez de automática por mensagem.
 */
export const extrairValorNota = onCall<ExtrairValorNotaRequest>(
  { secrets: ["ANTHROPIC_API_KEY"] },
  async (req) => {
    if (!req.auth) {
      throw new HttpsError("unauthenticated", "É preciso estar autenticado no Eleve.");
    }

    const { base64, mimeType } = req.data;
    if (!base64 || !mimeType) {
      throw new HttpsError("invalid-argument", "Arquivo não informado.");
    }

    const buffer = Buffer.from(base64, "base64");
    const extraido = mimeType === "application/pdf"
      ? await extractFromPdf(buffer)
      : await extractFromImage(buffer, mimeType);

    return {
      valor: extraido.valor,
      data: extraido.data,
      estabelecimento: extraido.estabelecimento,
      descricao: extraido.descricao,
    };
  }
);
