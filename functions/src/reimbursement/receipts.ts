import { onCall, HttpsError } from "firebase-functions/v2/https";
import JSZip from "jszip";
import { bucket } from "../firestore/db";

interface BaixarComprovantesRequest {
  storagePaths: string[];
}

/**
 * Junta vários comprovantes (recibos/notas) do Storage num único .zip e devolve em base64.
 * Feito no backend (Admin SDK) em vez do navegador buscar cada arquivo direto do Storage,
 * pra não depender de configuração de CORS no bucket.
 */
export const baixarComprovantesZip = onCall<BaixarComprovantesRequest>(async (req) => {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "É preciso estar autenticado no Eleve.");
  }

  const paths = (req.data.storagePaths ?? []).filter(Boolean);
  if (paths.length === 0) {
    throw new HttpsError("invalid-argument", "Nenhum comprovante informado.");
  }

  const zip = new JSZip();
  let encontrados = 0;

  await Promise.all(
    paths.map(async (path, i) => {
      try {
        const [buffer] = await bucket.file(path).download();
        const nomeOriginal = path.split("/").pop() || `comprovante-${i + 1}`;
        zip.file(`${i + 1}_${nomeOriginal}`, buffer);
        encontrados++;
      } catch {
        // Comprovante pode ter sido removido do Storage depois do lançamento — ignora e segue.
      }
    })
  );

  if (encontrados === 0) {
    throw new HttpsError("not-found", "Nenhum dos comprovantes foi encontrado no Storage.");
  }

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  return { base64: zipBuffer.toString("base64"), total: encontrados };
});
