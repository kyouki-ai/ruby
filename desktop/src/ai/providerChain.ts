import { logError } from '../logger';

export interface ProviderAttempt<T> {
  name: string;
  configured: boolean;
  call: () => Promise<T>;
}

/**
 * Tries each configured provider in priority order, falling through to the
 * next one on any failure (rate limit, timeout, bad key, whatever) instead
 * of surfacing the error - each provider is a separate account with its own
 * independent quota, so one failing says nothing about the next. Used to
 * chain Groq -> Gemini -> Cloudflare for notes/chat/quiz (see notesBuilder.ts
 * and chatReply.ts) so a single exhausted free tier doesn't fail the request
 * outright as long as another provider is configured.
 */
export async function tryProviders<T>(attempts: ProviderAttempt<T>[]): Promise<T> {
  const applicable = attempts.filter((a) => a.configured);
  if (applicable.length === 0) {
    throw new Error('No AI provider is configured. Add a Gemini, Groq, or Cloudflare key in Settings.');
  }
  let lastError: Error = new Error('All configured AI providers failed');
  for (let i = 0; i < applicable.length; i++) {
    try {
      return await applicable[i].call();
    } catch (err) {
      lastError = err as Error;
      if (i < applicable.length - 1) {
        logError(`${applicable[i].name} failed - falling back to ${applicable[i + 1].name}`, err);
      }
    }
  }
  throw lastError;
}
