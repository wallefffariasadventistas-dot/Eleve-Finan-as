import { config } from "../config";

const API_BASE = `https://api.telegram.org/bot${config.telegram.botToken}`;
const FILE_BASE = `https://api.telegram.org/file/bot${config.telegram.botToken}`;

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  oga: "audio/ogg",
  ogg: "audio/ogg",
};

async function chamarApi<T>(metodo: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/${metodo}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Falha ao chamar Telegram ${metodo}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** Envia uma mensagem de texto simples para o chat do dono. */
export async function sendText(chatId: string, text: string): Promise<void> {
  await chamarApi("sendMessage", { chat_id: chatId, text });
}

/** Envia uma pergunta com botões inline de resposta rápida (ex: escolher tipo de despesa). */
export async function sendButtons(
  chatId: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>
): Promise<void> {
  await chamarApi("sendMessage", {
    chat_id: chatId,
    text: bodyText,
    reply_markup: {
      inline_keyboard: buttons.map((b) => [{ text: b.title.slice(0, 64), callback_data: b.id.slice(0, 64) }]),
    },
  });
}

/** Tira o "carregando" do botão depois que o usuário toca nele. */
export async function answerCallback(callbackQueryId: string): Promise<void> {
  await chamarApi("answerCallbackQuery", { callback_query_id: callbackQueryId }).catch(() => {});
}

/** Baixa um arquivo (foto, nota de voz, documento) recebido no webhook a partir do file_id. */
export async function downloadMedia(fileId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const info = await chamarApi<{ result: { file_path: string } }>("getFile", { file_id: fileId });
  const filePath = info.result.file_path;

  const fileRes = await fetch(`${FILE_BASE}/${filePath}`);
  if (!fileRes.ok) {
    throw new Error(`Falha ao baixar arquivo do Telegram ${filePath}: ${fileRes.status}`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}
