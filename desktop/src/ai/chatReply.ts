import { streamChatReply as streamChatReplyGemini, buildChatSystemPrompt, ChatTurn } from '../gemini/geminiClient';
import { streamChatWithGroq, isGroqConfigured, GroqChatMessage } from '../groq/groqClient';
import { logError } from '../logger';

/**
 * The one entry point main.ts calls for chat - routes to Groq (once
 * configured) or Gemini exactly as before, sharing the same system prompt
 * text either way (see buildChatSystemPrompt in geminiClient.ts).
 */
export async function streamChatReply(
  contextMarkdown: string,
  history: ChatTurn[],
  newMessage: string,
  isGlobalScope: boolean,
  onDelta: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  if (!isGroqConfigured()) {
    return streamChatReplyGemini(contextMarkdown, history, newMessage, isGlobalScope, onDelta, signal);
  }

  const messages: GroqChatMessage[] = [
    { role: 'system', content: buildChatSystemPrompt(contextMarkdown, isGlobalScope) },
    ...history.map((turn) => ({
      role: (turn.role === 'model' ? 'assistant' : 'user') as GroqChatMessage['role'],
      content: turn.text,
    })),
    { role: 'user', content: newMessage },
  ];

  // Only fall back to Gemini if Groq fails before streaming anything - once
  // part of an answer has already reached the user, restarting on a second
  // provider would just duplicate/garble it instead of continuing it.
  let streamedAnything = false;
  try {
    return await streamChatWithGroq(
      messages,
      (delta) => {
        streamedAnything = true;
        onDelta(delta);
      },
      signal
    );
  } catch (err) {
    if (streamedAnything) throw err;
    logError('Groq chat failed before any output - falling back to Gemini', err);
    return streamChatReplyGemini(contextMarkdown, history, newMessage, isGlobalScope, onDelta, signal);
  }
}
