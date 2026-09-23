import {
  streamChatReply as streamChatReplyGemini,
  buildChatSystemPrompt,
  ChatTurn,
  isApiKeyConfigured,
} from '../gemini/geminiClient';
import { streamChatWithGroq, isGroqConfigured, GroqChatMessage } from '../groq/groqClient';
import { streamChatWithCloudflare, isCloudflareConfigured } from '../cloudflare/cloudflareClient';
import { logError } from '../logger';

/**
 * The one entry point main.ts calls for chat - tries Groq, then Gemini, then
 * Cloudflare Workers AI, in that order (each configured only if the user set
 * it up), sharing the same system prompt text across all three (see
 * buildChatSystemPrompt in geminiClient.ts).
 */
export async function streamChatReply(
  contextMarkdown: string,
  history: ChatTurn[],
  newMessage: string,
  isGlobalScope: boolean,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const messages: GroqChatMessage[] = [
    { role: 'system', content: buildChatSystemPrompt(contextMarkdown, isGlobalScope) },
    ...history.map((turn) => ({
      role: (turn.role === 'model' ? 'assistant' : 'user') as GroqChatMessage['role'],
      content: turn.text,
    })),
    { role: 'user', content: newMessage },
  ];

  const attempts = [
    { name: 'Groq', configured: isGroqConfigured(), run: (d: (t: string) => void) => streamChatWithGroq(messages, d, signal) },
    {
      name: 'Gemini',
      configured: isApiKeyConfigured(),
      run: (d: (t: string) => void) =>
        streamChatReplyGemini(contextMarkdown, history, newMessage, isGlobalScope, d, signal),
    },
    {
      name: 'Cloudflare',
      configured: isCloudflareConfigured(),
      run: (d: (t: string) => void) => streamChatWithCloudflare(messages, d, signal),
    },
  ].filter((a) => a.configured);

  if (attempts.length === 0) {
    throw new Error('No AI provider is configured. Add a Gemini, Groq, or Cloudflare key in Settings.');
  }

  let lastError: Error = new Error('All configured chat providers failed');
  for (let i = 0; i < attempts.length; i++) {
    // Only fall through to the next provider on a clean failure with nothing
    // shown yet - once part of an answer has reached the user, restarting on
    // a different provider would just duplicate/garble it instead of
    // continuing it, so a mid-stream failure is rethrown as-is.
    let streamedAnything = false;
    try {
      return await attempts[i].run((delta) => {
        streamedAnything = true;
        onDelta(delta);
      });
    } catch (err) {
      lastError = err as Error;
      if (streamedAnything || i === attempts.length - 1) throw lastError;
      logError(`${attempts[i].name} chat failed before any output - falling back to ${attempts[i + 1].name}`, err);
    }
  }
  throw lastError;
}
