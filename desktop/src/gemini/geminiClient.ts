/**
 * Thin client for the free-tier Google Gemini API (generativelanguage.googleapis.com).
 * Used instead of local whisper.cpp/Ollama so the app doesn't need any GPU/CPU
 * horsepower from the user's machine - all inference runs on Google's servers,
 * at no cost, under the AI Studio free tier's rate limits.
 *
 * Requires a GEMINI_API_KEY (see README: aistudio.google.com/apikey, no card needed).
 */

// gemini-2.5-flash(-lite) started 404-ing with "no longer available to new
// users, use gemini-3.5-flash-lite / gemini-3.6-flash" - that's straight
// from Google's own error message, not a guess, so trust it over anything
// written in a comment or doc from before this session.
//
// Briefly shared MODEL_SYNTHESIS for better transcription quality, but its
// free-tier daily quota turned out to be just 20 requests/day/model (seen
// directly in a real 429 response, not a guess) - shared across
// transcription (by far the most frequent caller, once per ~30s chunk),
// notes-building, chat and the quiz feature, that ran out within one short
// conversation. Back to a separate, more generous quota bucket for the
// high-volume path.
const MODEL_HIGH_VOLUME = 'gemini-3.5-flash-lite';
const MODEL_SYNTHESIS = 'gemini-3.6-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface InlinePart {
  mimeType: string;
  base64Data: string;
}

// Each user pastes in their own free API key via the Settings tab (see
// secrets.ts - stored encrypted, loaded into this variable at app startup).
// More than one key (comma-separated in that same field) round-robins here -
// useful if someone hits the daily limit and has a second free account.
// A GEMINI_API_KEY environment variable / .env file still works as a
// developer-friendly single-key fallback.
let apiKeys: string[] = [];
let nextKeyIndex = 0;

export function setApiKeys(keys: string[]): void {
  apiKeys = keys.filter(Boolean);
  nextKeyIndex = 0;
}

export function isApiKeyConfigured(): boolean {
  return apiKeys.length > 0 || Boolean(process.env.GEMINI_API_KEY);
}

function keyPool(): string[] {
  if (apiKeys.length > 0) return apiKeys;
  if (process.env.GEMINI_API_KEY) return [process.env.GEMINI_API_KEY];
  throw new Error('Gemini API key is not set. Add it in the Settings tab (see README).');
}

/** Rotates through the configured key(s) - a fresh pick each call, including retries. */
function nextKey(): string {
  const pool = keyPool();
  const key = pool[nextKeyIndex % pool.length];
  nextKeyIndex++;
  return key;
}

const RETRYABLE_STATUS = new Set([429, 503]);

export interface GeminiResult {
  text: string;
  /** True when Gemini stopped only because it hit maxOutputTokens, not because it was actually done. */
  truncated: boolean;
}

async function callGemini(model: string, contents: unknown[], maxOutputTokens?: number): Promise<GeminiResult> {
  const maxAttempts = Math.max(3, keyPool().length);
  let lastError: Error = new Error('Gemini request failed');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // A fresh key each attempt: normal calls round-robin across the pool,
    // and a 429/503 retry automatically lands on a different key if one is
    // available, instead of hammering the same exhausted quota again.
    const apiKey = nextKey();

    let response: Response;
    try {
      response = await fetch(`${API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents,
          ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {}),
        }),
        // A hung request must not be able to block finalizing a lecture for
        // long - 20s, not 45s: a normal reply takes a few seconds, and the
        // "Собираю конспект..." button feeling stuck matters more than
        // giving a slow response every possible extra second to finish.
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastError = err as Error;
      break; // network/timeout error - retrying won't help within the same call
    }

    if (response.ok) {
      const data = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      };
      const candidate = data.candidates?.[0];
      return {
        text: candidate?.content?.parts?.[0]?.text ?? '',
        truncated: candidate?.finishReason === 'MAX_TOKENS',
      };
    }

    lastError = new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
    // 429 (rate limit) / 503 (temporary overload) are worth a retry (ideally
    // on the next key in the pool); anything else fails the same way again.
    if (!RETRYABLE_STATUS.has(response.status) || attempt === maxAttempts) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 800));
  }

  throw lastError;
}

/**
 * Same call as callGemini, but reads the response as it streams in and
 * reports each new slice of text via `onDelta` - lets the chat UI "type out"
 * a reply instead of popping in all at once after the full wait. No retry
 * across keys mid-stream (that would mean discarding and restarting partial
 * text the user already saw) - a stream that fails outright before any text
 * arrives just throws, same as a normal callGemini failure.
 */
async function streamGemini(
  model: string,
  contents: unknown[],
  onDelta: (text: string) => void,
  externalSignal?: AbortSignal
): Promise<string> {
  const apiKey = nextKey();
  // A separate internal controller (not just externalSignal itself) so the
  // 45s timeout and an explicit "stop" both abort the same underlying fetch,
  // while still being able to tell them apart afterward (see the catch
  // below) - a real timeout should still fail loudly, only an explicit stop
  // should quietly resolve with whatever text streamed in so far.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  const forwardAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', forwardAbort);
  let full = '';

  try {
    const response = await fetch(`${API_BASE}/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({ contents }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? ''; // last piece may be incomplete - keep it for next read
      for (const event of events) {
        const line = event.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const parsed = JSON.parse(line.slice(6));
          const delta: string = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
          if (delta) {
            full += delta;
            onDelta(delta);
          }
        } catch {
          // A split SSE frame straddling two reads - ignore, the tail is
          // carried over in `buffer` and reparsed once the rest arrives.
        }
      }
    }

    return full;
  } catch (err) {
    if (externalSignal?.aborted) return full;
    throw err;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

function singleTurnContents(promptText: string, inlineParts: InlinePart[]): unknown[] {
  const parts: unknown[] = [{ text: promptText }];
  for (const part of inlineParts) {
    parts.push({ inlineData: { mimeType: part.mimeType, data: part.base64Data } });
  }
  return [{ parts }];
}

export function generateText(prompt: string, maxOutputTokens?: number): Promise<string> {
  return callGemini(MODEL_SYNTHESIS, singleTurnContents(prompt, []), maxOutputTokens).then((r) => r.text);
}

/**
 * Same as generateText, but also reports whether Gemini stopped only because
 * it ran out of maxOutputTokens rather than actually finishing - lets a
 * caller that needs a long document (see notesBuilder.ts) detect a cut-off
 * response and ask for a continuation instead of silently truncating it.
 */
export function generateTextWithFinish(prompt: string, maxOutputTokens?: number): Promise<GeminiResult> {
  return callGemini(MODEL_SYNTHESIS, singleTurnContents(prompt, []), maxOutputTokens);
}

export function generateWithAudio(prompt: string, wavBase64: string): Promise<string> {
  return callGemini(MODEL_HIGH_VOLUME, singleTurnContents(prompt, [{ mimeType: 'audio/wav', base64Data: wavBase64 }])).then(
    (r) => r.text
  );
}

export function generateWithImage(prompt: string, jpegBase64: string): Promise<string> {
  return callGemini(MODEL_SYNTHESIS, singleTurnContents(prompt, [{ mimeType: 'image/jpeg', base64Data: jpegBase64 }])).then(
    (r) => r.text
  );
}

/** For an attached slide deck file - Gemini reads PDFs and images natively, page by page. */
export function generateWithDocument(prompt: string, base64Data: string, mimeType: string): Promise<string> {
  return callGemini(MODEL_SYNTHESIS, singleTurnContents(prompt, [{ mimeType, base64Data }])).then((r) => r.text);
}

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

/** Shared with the Groq chat path (see ai/chatReply.ts) so both providers get the exact same instructions. */
export function buildChatSystemPrompt(contextMarkdown: string, isGlobalScope: boolean): string {
  const scopeInstruction = isGlobalScope
    ? 'Ниже — конспекты по ВСЕМ предметам студента, разделённые заголовками "# Предмет: …". ' +
      'Сам определи, какого предмета касается вопрос, и отвечай по нему, не смешивая с другими ' +
      '(если явно не попросят сравнить или дать сводку по всему).'
    : 'Ниже — конспекты по одному предмету/лекции, который сейчас открыт.';

  return (
    'Ты — учебный ассистент студента. ' +
    scopeInstruction +
    ' Отвечай на вопросы, помогай готовиться к зачётам и контрольным, объясняй термины, ' +
    'составляй по запросу тесты и списки вопросов для самопроверки. ' +
    'Опирайся в первую очередь на эти конспекты; если в них чего-то не хватает для ответа, ' +
    'можешь дополнить общими знаниями, но отметь, что это не из конспекта. ' +
    'Конспекты ниже — это справочный материал для ответов по существу, а не тема для пересказа по умолчанию: ' +
    'на приветствие или обычную реплику ("привет", "как дела", "спасибо") отвечай так же коротко и естественно, ' +
    'не пересказывай и не суммируй конспект, пока тебя не попросят об этом прямо.\n\n' +
    `КОНСПЕКТЫ:\n${contextMarkdown || '(конспектов пока нет)'}`
  );
}

function buildChatContents(contextMarkdown: string, history: ChatTurn[], newMessage: string, isGlobalScope: boolean) {
  const systemPrompt = buildChatSystemPrompt(contextMarkdown, isGlobalScope);

  return [
    { role: 'user', parts: [{ text: systemPrompt }] },
    { role: 'model', parts: [{ text: 'Хорошо, готов отвечать по этим конспектам.' }] },
    ...history.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    { role: 'user', parts: [{ text: newMessage }] },
  ];
}

/**
 * Study-assistant chat, grounded in saved notes. `isGlobalScope` switches the
 * instructions between "one subject/lecture was picked for you" and "figure
 * out yourself which subject(s) the question is about" - the default chat
 * screen passes every subject's notes and lets the model pick, so nobody has
 * to open a specific folder just to ask "what's the homework in math".
 */
export function generateChatReply(
  contextMarkdown: string,
  history: ChatTurn[],
  newMessage: string,
  isGlobalScope: boolean
): Promise<string> {
  return callGemini(MODEL_SYNTHESIS, buildChatContents(contextMarkdown, history, newMessage, isGlobalScope)).then(
    (r) => r.text
  );
}

/** Same as generateChatReply, but "types out" the reply via onDelta as it streams in. */
export function streamChatReply(
  contextMarkdown: string,
  history: ChatTurn[],
  newMessage: string,
  isGlobalScope: boolean,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return streamGemini(
    MODEL_SYNTHESIS,
    buildChatContents(contextMarkdown, history, newMessage, isGlobalScope),
    onDelta,
    signal
  );
}
