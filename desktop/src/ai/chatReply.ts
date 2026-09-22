import { streamChatReply as streamChatReplyGemini, buildChatSystemPrompt, ChatTurn } from '../gemini/geminiClient';
import { streamChatWithGroq, isGroqConfigured, GroqChatMessage } from '../groq/groqClient';

/**
 * The one entry point main.ts calls for chat - routes to Groq (once
 * configured) or Gemini exactly as before, sharing the same system prompt
 * text either way (see buildChatSystemPrompt in geminiClient.ts).
 */
export function streamChatReply(
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

  return streamChatWithGroq(messages, onDelta, signal);
}
