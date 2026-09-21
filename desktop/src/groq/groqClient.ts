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
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

let groqApiKey: string | null = null;
// Two different guessed model names ("llama-3.3-70b-versatile", then
// "llama-3.1-8b-instant") both 404'd with "does not exist or you do not have
// access to it" on the same key - guessing a third name isn't worth trying
// again. Instead, ask Groq's own /models endpoint what this specific
// account can actually use, once per key, and go with that.
let cachedTextModel: string | null = null;

export function setGroqApiKey(key: string | null): void {
  groqApiKey = key && key.trim() ? key.trim() : null;
  cachedTextModel = null;
}

export function isGroqConfigured(): boolean {
  return groqApiKey !== null;
}

async function resolveTextModel(): Promise<string> {
  if (cachedTextModel) return cachedTextModel;
  if (!groqApiKey) throw new Error('Groq API key is not set.');

  const response = await fetch(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${groqApiKey}` } });
  if (!response.ok) {
    throw new Error(`Groq request failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { data?: { id: string }[] };
  const ids = (data.data ?? []).map((m) => m.id);

  // Skip anything that isn't a text chat model (Whisper, TTS, moderation/guard models).
  const candidates = ids.filter((id) => !/whisper|tts|guard|moderation|prompt-guard/i.test(id));
  const preferred =
    candidates.find((id) => /llama-3\.[13]-(70b|8b)/i.test(id)) ??
    candidates.find((id) => /llama/i.test(id)) ??
    candidates[0];

  if (!preferred) {
    throw new Error(`Groq: this account has no usable chat model (models seen: ${ids.join(', ') || 'none'}).`);
  }
  cachedTextModel = preferred;
  return preferred;
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

/** Groq's 429 body includes its own "Please try again in 21.9s" hint - use it instead of a blind guess. */
function parseRetryDelayMs(errorText: string): number {
  const match = errorText.match(/try again in ([\d.]+)\s*s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) + 500 : 5000;
}

/**
 * Groq's free tier limits tokens-per-minute, not just requests-per-day - a
 * single large conspect rebuild can trip it on its own. That resets within
 * seconds (the error names the exact wait), unlike Gemini's daily quota, so
 * one retry after the hinted delay is worth doing automatically instead of
 * making the user click the button again.
 */
async function postChatCompletion(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
  if (!groqApiKey) throw new Error('Groq API key is not set.');
  const send = () =>
    fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqApiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

  let response = await send();
  if (response.status === 429) {
    const delayMs = parseRetryDelayMs(await response.text());
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await send();
  }
  return response;
}

/** Plain one-shot text generation (notes-building, the quiz) - no chat history involved. */
export async function generateTextWithGroq(prompt: string): Promise<string> {
  const model = await resolveTextModel();
  const response = await postChatCompletion({ model, messages: [{ role: 'user', content: prompt }] }, 30_000);

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
  const model = await resolveTextModel();
  const response = await postChatCompletion({ model, messages, stream: true }, 45_000);

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
