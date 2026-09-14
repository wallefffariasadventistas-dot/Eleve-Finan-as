import { bucket } from "../firestore/db";
import { config } from "../config";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
};

/**
 * Salva o comprovante original (foto, áudio ou PDF) na nuvem e devolve o caminho no bucket.
 * `sufixo` diferencia comprovantes quando mais de um é enviado pra mesma despesa
 * (ex: "-2", "-3" — o primeiro fica sem sufixo, como sempre foi).
 */
export async function salvarComprovante(
  despesaId: string,
  buffer: Buffer,
  mimeType: string,
  sufixo = ""
): Promise<string> {
  const ext = EXT_BY_MIME[mimeType] ?? "bin";
  const path = `${config.storageBucketReceiptsPrefix}/${despesaId}/original${sufixo}.${ext}`;
  const file = bucket.file(path);
  await file.save(buffer, { metadata: { contentType: mimeType } });
  return path;
}

export async function gerarUrlAssinada(storagePath: string): Promise<string> {
  const [url] = await bucket.file(storagePath).getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 dias — suficiente para o e-mail de reembolso
  });
  return url;
}
