/**
 * Cloudflare Workers AI, used as a third, last-resort text provider - only
 * reached once both Gemini and Groq have failed a given request (see
 * notesBuilder.ts and chatReply.ts). No free-tier daily/per-minute quota is
 * shared with those two, so it's genuine extra headroom rather than another
 * account on the same rate limit. Free, no card required, but needs two
 * pieces from the Cloudflare dashboard (an account ID and an API token)
 * instead of a single key.
 *
 * Uses Cloudflare's official OpenAI-compatible chat completions endpoint -
 * there is no equivalent official endpoint for Whisper/audio transcription,
 * so this client (unlike Groq's) only covers text.
 */

const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

let credentials: CloudflareCredentials | null = null;

export function setCloudflareCredentials(creds: CloudflareCredentials | null): void {
  credentials = creds && creds.accountId && creds.apiToken ? creds : null;
}

export function isCloudflareConfigured(): boolean {
  return credentials !== null;
}

function chatUrl(): string {
  if (!credentials) throw new Error('Cloudflare credentials are not set.');
  return `https://api.cloudflare.com/client/v4/accounts/${credentials.accountId}/ai/v1/chat/completions`;
}

export interface CloudflareResult {
  text: string;
  /** True when Cloudflare stopped only because it hit max_tokens, not because it was actually done. */
  truncated: boolean;
}

/** Plain one-shot text generation (notes-building, the quiz) - no chat history involved. */
export async function generateTextWithCloudflare(prompt: string, maxTokens?: number): Promise<string> {
  return (await generateTextWithCloudflareFinish(prompt, maxTokens)).text;
}

/** Same as generateTextWithCloudflare, but also reports whether the response was cut off by max_tokens. */
export async function generateTextWithCloudflareFinish(prompt: string, maxTokens?: number): Promise<CloudflareResult> {
  if (!credentials) throw new Error('Cloudflare credentials are not set.');
  // A flat 30s was fine for chat-sized replies, but a "Подробно" conspect
  // rebuild asks for up to 8000 tokens and can genuinely take longer than
  // that to generate - same reasoning as groqClient.ts's timeoutForMaxTokens.
  const timeoutMs = maxTokens && maxTokens > 1000 ? 90_000 : 30_000;
  const response = await fetch(chatUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.apiToken}` },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare request failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  return { text: choice?.message?.content ?? '', truncated: choice?.finish_reason === 'length' };
}

export interface CloudflareChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Same idea as groqClient.ts's streamChatWithGroq - reads the chat completion as it streams in. */
export async function streamChatWithCloudflare(
  messages: CloudflareChatMessage[],
  onDelta: (text: string) => void,
  externalSignal?: AbortSignal
): Promise<string> {
  let full = '';
  // The timeout/abort wiring must stay live for the WHOLE call, not just the
  // initial fetch - it used to be cleared in an inner finally right after
  // fetch() resolved (headers received, stream just starting), which meant a
  // stream that then hung had no timeout to abort it, and clicking "Stop"
  // mid-stream did nothing (the listener was already removed).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  const forwardAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', forwardAbort);

  try {
    const response = await fetch(chatUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials!.apiToken}` },
      body: JSON.stringify({ model: CHAT_MODEL, messages, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Cloudflare request failed: ${response.status} ${await response.text()}`);
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
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}
