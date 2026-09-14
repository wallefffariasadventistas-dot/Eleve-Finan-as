import { FieldValue } from "firebase-admin/firestore";
import { collections } from "./db";

export interface ArquivoGrupo {
  fileId: string;
  tipo: "photo" | "document";
  mimeType?: string;
  caption?: string;
}

interface GrupoMidia {
  chatId: string;
  arquivos: ArquivoGrupo[];
  atualizadoEmMs: number;
  processado: boolean;
}

const JANELA_ESPERA_MS = 2500;

/**
 * O Telegram manda cada foto de um álbum como uma mensagem separada, todas com o mesmo
 * media_group_id, chegando em rajada. Como cada mensagem dispara uma invocação própria da
 * function, a única forma confiável de "esperar todas chegarem" sem infraestrutura extra
 * (fila, agendador) é: cada invocação registra seu arquivo no grupo, espera um pouco, e só
 * a que não vê nenhuma atualização mais nova depois da espera é quem processa o grupo
 * inteiro de uma vez — as outras simplesmente não fazem nada.
 */
export async function registrarArquivoEAguardarSeUltimo(
  mediaGroupId: string,
  chatId: string,
  arquivo: ArquivoGrupo
): Promise<ArquivoGrupo[] | null> {
  const ref = collections.mediaGroups.doc(mediaGroupId);
  const agora = Date.now();

  await ref.set(
    {
      chatId,
      arquivos: FieldValue.arrayUnion(arquivo),
      atualizadoEmMs: agora,
      processado: false,
    },
    { merge: true }
  );

  await new Promise((resolve) => setTimeout(resolve, JANELA_ESPERA_MS));

  const snap = await ref.get();
  const dados = snap.data() as GrupoMidia | undefined;
  if (!dados || dados.processado || dados.atualizadoEmMs !== agora) {
    return null; // não foi a última mensagem do grupo, ou outra invocação já está processando
  }

  await ref.update({ processado: true });
  return dados.arquivos;
}
