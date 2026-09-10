import { config } from "../config";

const GRAPH_BASE = `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

function authHeaders() {
  return {
    Authorization: `Bearer ${config.whatsapp.accessToken}`,
    "Content-Type": "application/json",
  };
}

/** Envia uma mensagem de texto simples para um número (formato internacional, só dígitos). */
export async function sendText(to: string, body: string): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao enviar WhatsApp: ${res.status} ${await res.text()}`);
  }
}

/** Envia uma pergunta com botões de resposta rápida (ex: escolher tipo de despesa). */
export async function sendButtons(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>
): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao enviar botões WhatsApp: ${res.status} ${await res.text()}`);
  }
}

/** Baixa um arquivo de mídia (foto, áudio, documento) recebido no webhook a partir do media id. */
export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaRes = await fetch(`${GRAPH_BASE}/${mediaId}`, { headers: authHeaders() });
  if (!metaRes.ok) {
    throw new Error(`Falha ao resolver mídia ${mediaId}: ${metaRes.status}`);
  }
  const meta = (await metaRes.json()) as { url: string; mime_type: string };

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
  });
  if (!fileRes.ok) {
    throw new Error(`Falha ao baixar mídia ${mediaId}: ${fileRes.status}`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType: meta.mime_type };
}
