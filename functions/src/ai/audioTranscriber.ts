import speech from "@google-cloud/speech";

const client = new speech.SpeechClient();

/**
 * Transcreve uma nota de voz do Telegram (formato OGG/Opus) para texto em português.
 * Usa o Google Cloud Speech-to-Text — já autenticado automaticamente via a service account
 * do próprio projeto Firebase, sem precisar de chave extra.
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const [response] = await client.recognize({
    audio: { content: audioBuffer.toString("base64") },
    config: {
      encoding: "OGG_OPUS",
      sampleRateHertz: 16000,
      languageCode: "pt-BR",
      model: "latest_long",
      enableAutomaticPunctuation: true,
    },
  });

  const transcript = (response.results ?? [])
    .map((r) => r.alternatives?.[0]?.transcript ?? "")
    .join(" ")
    .trim();

  if (!transcript) {
    throw new Error("Não foi possível entender o áudio.");
  }
  return transcript;
}
