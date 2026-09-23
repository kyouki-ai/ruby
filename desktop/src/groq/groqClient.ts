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

// Each user pastes in their own free Groq key via the Settings tab (see
// secrets.ts - stored encrypted). More than one key (comma/newline-separated
// in that same field) round-robins here - useful once someone hits Groq's
// free-tier tokens-per-minute limit and has a second free account, same
// pattern as geminiClient.ts's multi-key support.
let apiKeys: string[] = [];
let nextKeyIndex = 0;
// Two different guessed model names ("llama-3.3-70b-versatile", then
// "llama-3.1-8b-instant") both 404'd with "does not exist or you do not have
// access to it" on the same key - guessing a third name isn't worth trying
// again. Instead, ask Groq's own /models endpoint what this specific
// account can actually use, once per key, and go with that.
let cachedTextModel: string | null = null;

export function setGroqApiKeys(keys: string[]): void {
  apiKeys = keys.filter(Boolean);
  nextKeyIndex = 0;
  cachedTextModel = null;
}

export function isGroqConfigured(): boolean {
  return apiKeys.length > 0;
}

function keyPool(): string[] {
  if (apiKeys.length === 0) throw new Error('Groq API key is not set.');
  return apiKeys;
}

/** Rotates through the configured key(s) - a fresh pick each call, including retries. */
function nextKey(): string {
  const pool = keyPool();
  const key = pool[nextKeyIndex % pool.length];
  nextKeyIndex++;
  return key;
}

const RETRYABLE_STATUS = new Set([429, 503]);

async function resolveTextModel(): Promise<string> {
  if (cachedTextModel) return cachedTextModel;
  const apiKey = nextKey();

  const response = await fetch(GROQ_MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) {
    throw new Error(`Groq request failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { data?: { id: string }[] };
  const ids = (data.data ?? []).map((m) => m.id);

  // Groq's /models catalog mixes real text chat models in with Whisper (STT),
  // "canopylabs/orpheus-*" (TTS), and guard/moderation models, and it keeps
  // changing - excluding known non-chat keywords already missed "orpheus"
  // once in production: it silently became the last-resort candidates[0]
  // pick and broke chat outright with a "requires terms acceptance" error,
  // never even reaching the Gemini/Cloudflare fallback because the request
  // itself was malformed for that model, not merely rate-limited. Allowlisting
  // known chat model *families* instead is safer against catalog changes -
  // an unrecognized family now fails resolveTextModel() loudly (which the
  // fallback chain in notesBuilder.ts/chatReply.ts already handles) instead
  // of silently sending real user requests to a broken model.
  const candidates = ids.filter((id) => /(?:^|\/)(llama|gpt-oss|qwen|mixtral|gemma|deepseek)/i.test(id));
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

/** Groq's 429 body includes its own "Please try again in 21.9s" hint - use it instead of a blind guess. */
function parseRetryDelayMs(errorText: string): number {
  const match = errorText.match(/try again in ([\d.]+)\s*s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) + 500 : 5000;
}

export async function transcribeWithGroq(wavBuffer: Buffer): Promise<string> {
  const pool = keyPool();
  const maxAttempts = Math.max(2, pool.length);
  let lastError: Error = new Error('Groq request failed');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const apiKey = nextKey();
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'text');

    const response = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });

    if (response.ok) return (await response.text()).trim();

    const errorText = await response.text();
    lastError = new Error(`Groq request failed: ${response.status} ${errorText}`);
    if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) break;
    // A second key is a different account's quota - worth trying right away.
    // With only one key, the same account needs the hinted cooldown first.
    if (pool.length === 1) await new Promise((resolve) => setTimeout(resolve, parseRetryDelayMs(errorText)));
  }

  throw lastError;
}

/**
 * Groq's free tier limits tokens-per-minute per account, not just
 * requests-per-day - a single large conspect rebuild can trip it on its own.
 * A second configured key (a different free account) gets tried immediately
 * on a 429 instead of waiting; with only one key, this waits out Groq's own
 * hinted cooldown before retrying, same as before multi-key support existed.
 */
async function postChatCompletion(
  body: Record<string, unknown>,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const pool = keyPool();
  const maxAttempts = Math.max(2, pool.length);
  // A separate internal controller, same reasoning as geminiClient's
  // streamGemini - the timeout and an explicit "stop" both need to abort the
  // same fetch, but only the latter should be treated as a quiet, expected
  // stop rather than a real failure (see streamChatWithGroq's catch).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', forwardAbort);

  try {
    let response: Response | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (controller.signal.aborted) break;
      const apiKey = nextKey();
      response = await fetch(GROQ_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status !== 429 || attempt === maxAttempts) break;
      if (pool.length === 1) {
        const delayMs = parseRetryDelayMs(await response.clone().text());
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return response!;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

export interface GroqResult {
  text: string;
  /** True when Groq stopped only because it hit max_tokens, not because it was actually done. */
  truncated: boolean;
}

/** Plain one-shot text generation (notes-building, the quiz) - no chat history involved. */
export async function generateTextWithGroq(prompt: string, maxTokens?: number): Promise<string> {
  return (await generateTextWithGroqFinish(prompt, maxTokens)).text;
}

/**
 * Some auto-picked Groq models (see resolveTextModel) have a real max_tokens
 * ceiling well below what their listed context window would suggest - Groq
 * then rejects the request outright with a 400 naming the actual ceiling
 * (seen in production: "max_tokens must be less than or equal to `512`").
 * Parsing that number out and retrying once with it beats permanently
 * failing every "Подробно" request against that model for the rest of the
 * session (falling through to Gemini/Cloudflare every single round instead
 * of ever actually using the configured Groq key).
 */
function parseMaxTokensCeiling(errorText: string): number | null {
  const match = errorText.match(/max_tokens.*?less than or equal to `?(\d+)`?/i);
  return match ? parseInt(match[1], 10) : null;
}

/** Same as generateTextWithGroq, but also reports whether the response was cut off by max_tokens (see notesBuilder.ts's continuation loop). */
export async function generateTextWithGroqFinish(prompt: string, maxTokens?: number): Promise<GroqResult> {
  const model = await resolveTextModel();
  const body = (tokens?: number) => ({
    model,
    messages: [{ role: 'user', content: prompt }],
    ...(tokens ? { max_tokens: tokens } : {}),
  });
  let response = await postChatCompletion(body(maxTokens), 30_000);

  if (!response.ok && response.status === 400 && maxTokens) {
    const errorText = await response.clone().text();
    const ceiling = parseMaxTokensCeiling(errorText);
    if (ceiling && ceiling < maxTokens) {
      response = await postChatCompletion(body(ceiling), 30_000);
    }
  }

  if (!response.ok) {
    throw new Error(`Groq request failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  return { text: choice?.message?.content ?? '', truncated: choice?.finish_reason === 'length' };
}

export interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Same idea as geminiClient's streamGemini - reads the chat completion as it streams in. */
export async function streamChatWithGroq(
  messages: GroqChatMessage[],
  onDelta: (text: string) => void,
  externalSignal?: AbortSignal
): Promise<string> {
  let full = '';
  try {
    const model = await resolveTextModel();
    const response = await postChatCompletion({ model, messages, stream: true }, 45_000, externalSignal);

    if (!response.ok || !response.body) {
      throw new Error(`Groq request failed: ${response.status} ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
  } catch (err) {
    if (externalSignal?.aborted) return full;
    throw err;
  }
}
