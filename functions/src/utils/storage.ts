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

/** Apaga todos os comprovantes salvos de uma despesa — usado quando o lançamento é cancelado no meio do fluxo. */
export async function excluirComprovantes(despesaId: string): Promise<void> {
  await bucket.deleteFiles({ prefix: `${config.storageBucketReceiptsPrefix}/${despesaId}/` }).catch(() => {});
}

/**
 * Copia os comprovantes já salvos de uma despesa pra pasta de uma nota fixa (usado quando o
 * dono escolhe "Relatório Fixo Mensal" como destino em vez de Viagem/Departamento/Pessoal —
 * a despesa original é apagada depois, então os arquivos originais precisam ser preservados
 * na nova pasta antes disso).
 */
export async function copiarComprovantesParaNotaFixa(notaId: string, caminhosOrigem: string[]): Promise<string[]> {
  const novosCaminhos: string[] = [];
  for (const caminhoAntigo of caminhosOrigem) {
    const nomeArquivo = caminhoAntigo.split("/").pop() ?? "original";
    const novoCaminho = `notas-fixas/${notaId}/${nomeArquivo}`;
    await bucket.file(caminhoAntigo).copy(novoCaminho);
    novosCaminhos.push(novoCaminho);
  }
  return novosCaminhos;
}

export async function gerarUrlAssinada(storagePath: string): Promise<string> {
  const [url] = await bucket.file(storagePath).getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 dias — suficiente para o e-mail de reembolso
  });
  return url;
}
