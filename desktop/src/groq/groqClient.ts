/**
 * Optional second provider. Started out covering only audio transcription
 * (Groq's free Whisper has a separate, more generous quota than Gemini's),
 * but Gemini's free tier turned out to cap gemini-3.6-flash at just 20
 * requests/day *total*, shared across notes-building, chat and the quiz
 * feature too - so once a Groq key is configured, all of those move here as
 * well (Groq's free Llama models have much more daily headroom). Slide
 * descriptions stay on Gemini regardless - Groq's free tier doesn't offer a
 * comparable vision model.
 */

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TEXT_MODEL = 'llama-3.3-70b-versatile';

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

/** Plain one-shot text generation (notes-building, the quiz) - no chat history involved. */
export async function generateTextWithGroq(prompt: string): Promise<string> {
  if (!groqApiKey) throw new Error('Groq API key is not set.');

  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqApiKey}` },
    body: JSON.stringify({ model: GROQ_TEXT_MODEL, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Groq request failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '';
}

export interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Same idea as geminiClient's streamGemini - reads the chat completion as it streams in. */
export async function streamChatWithGroq(
  messages: GroqChatMessage[],
  onDelta: (text: string) => void
): Promise<string> {
  if (!groqApiKey) throw new Error('Groq API key is not set.');

  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqApiKey}` },
    body: JSON.stringify({ model: GROQ_TEXT_MODEL, messages, stream: true }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Groq request failed: ${response.status} ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const event of events) {
      const line = event.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const delta: string = parsed.choices?.[0]?.delta?.content ?? '';
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        // A split SSE frame straddling two reads - the tail is carried over in `buffer`.
      }
    }
  }

  return full;
}
