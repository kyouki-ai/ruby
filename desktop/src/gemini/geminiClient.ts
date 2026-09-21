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
// Transcription used to run on the "-lite" tier to conserve free-tier quota
// (it's the most frequent call, once per recorded chunk) - the user chose
// transcription accuracy over quota headroom instead, so it now shares the
// stronger model with notes-building and chat. A day of back-to-back
// lectures on one free key may hit the daily limit sooner as a result.
const MODEL_HIGH_VOLUME = 'gemini-3.6-flash';
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

async function callGemini(model: string, contents: unknown[]): Promise<string> {
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
        body: JSON.stringify({ contents }),
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
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
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
async function streamGemini(model: string, contents: unknown[], onDelta: (text: string) => void): Promise<string> {
  const apiKey = nextKey();
  const response = await fetch(`${API_BASE}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({ contents }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
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
}

function singleTurnContents(promptText: string, inlineParts: InlinePart[]): unknown[] {
  const parts: unknown[] = [{ text: promptText }];
  for (const part of inlineParts) {
    parts.push({ inlineData: { mimeType: part.mimeType, data: part.base64Data } });
  }
  return [{ parts }];
}

export function generateText(prompt: string): Promise<string> {
  return callGemini(MODEL_SYNTHESIS, singleTurnContents(prompt, []));
}

export function generateWithAudio(prompt: string, wavBase64: string): Promise<string> {
  return callGemini(MODEL_HIGH_VOLUME, singleTurnContents(prompt, [{ mimeType: 'audio/wav', base64Data: wavBase64 }]));
}

export function generateWithImage(prompt: string, jpegBase64: string): Promise<string> {
  return callGemini(MODEL_SYNTHESIS, singleTurnContents(prompt, [{ mimeType: 'image/jpeg', base64Data: jpegBase64 }]));
}

/** For an attached slide deck file - Gemini reads PDFs and images natively, page by page. */
export function generateWithDocument(prompt: string, base64Data: string, mimeType: string): Promise<string> {
  return callGemini(MODEL_SYNTHESIS, singleTurnContents(prompt, [{ mimeType, base64Data }]));
}

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

function buildChatContents(contextMarkdown: string, history: ChatTurn[], newMessage: string, isGlobalScope: boolean) {
  const scopeInstruction = isGlobalScope
    ? 'Ниже — конспекты по ВСЕМ предметам студента, разделённые заголовками "# Предмет: …". ' +
      'Сам определи, какого предмета касается вопрос, и отвечай по нему, не смешивая с другими ' +
      '(если явно не попросят сравнить или дать сводку по всему).'
    : 'Ниже — конспекты по одному предмету/лекции, который сейчас открыт.';

  const systemPrompt =
    'Ты — учебный ассистент студента. ' +
    scopeInstruction +
    ' Отвечай на вопросы, помогай готовиться к зачётам и контрольным, объясняй термины, ' +
    'составляй по запросу тесты и списки вопросов для самопроверки. ' +
    'Опирайся в первую очередь на эти конспекты; если в них чего-то не хватает для ответа, ' +
    'можешь дополнить общими знаниями, но отметь, что это не из конспекта.\n\n' +
    `КОНСПЕКТЫ:\n${contextMarkdown || '(конспектов пока нет)'}`;

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
  return callGemini(MODEL_SYNTHESIS, buildChatContents(contextMarkdown, history, newMessage, isGlobalScope));
}

/** Same as generateChatReply, but "types out" the reply via onDelta as it streams in. */
export function streamChatReply(
  contextMarkdown: string,
  history: ChatTurn[],
  newMessage: string,
  isGlobalScope: boolean,
  onDelta: (text: string) => void
): Promise<string> {
  return streamGemini(MODEL_SYNTHESIS, buildChatContents(contextMarkdown, history, newMessage, isGlobalScope), onDelta);
}
