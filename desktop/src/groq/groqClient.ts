/**
 * Optional second provider, used only for audio transcription. Groq's free
 * tier serves Whisper (speech-to-text) with a separate, more generous daily
 * quota than Gemini's - since transcription is by far the most frequent call
 * during a lecture (once per ~30s chunk), moving just that one call here
 * keeps Gemini's tight free-tier quota for notes-building, chat and the quiz
 * feature, which need it far less often. Slide descriptions stay on Gemini
 * regardless - Groq's free tier doesn't offer a comparable vision model.
 */

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

let groqApiKey: string | null = null;

export function setGroqApiKey(key: string | null): void {
  groqApiKey = key && key.trim() ? key.trim() : null;
}

export function isGroqConfigured(): boolean {
  return groqApiKey !== null;
}

export async function transcribeWithGroq(wavBuffer: Buffer): Promise<string> {
  if (!groqApiKey) throw new Error('Groq API key is not set.');

  const form = new FormData();
  form.append('file', new Blob([Uint8Array.from(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'text');

  const response = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${groqApiKey}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Groq request failed: ${response.status} ${await response.text()}`);
  }
  return (await response.text()).trim();
}
