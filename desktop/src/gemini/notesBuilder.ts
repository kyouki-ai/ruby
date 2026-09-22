import { generateText, generateTextWithFinish } from './geminiClient';
import { generateTextWithGroq, generateTextWithGroqFinish, isGroqConfigured } from '../groq/groqClient';
import { TranscriptSegment } from '../transcription/audioPipeline';
import { SlideEntry } from '../slides/slidePipeline';

export type NotesDetailLevel = 'concise' | 'detailed';

// Every model has a hard per-response length ceiling regardless of how high
// maxOutputTokens/max_tokens is set - a real ~10-page conspect needs more
// than one response can hold. generateLongText below detects a
// cut-off response (via finish_reason/finishReason, not by guessing from the
// text) and asks the model to continue, stitching the pieces together
// instead of just accepting a truncated document.
const DETAILED_MAX_TOKENS = 8000;
const MAX_CONTINUATIONS = 5;

/** Routes to Groq when the user configured a key (see groqClient.ts), else Gemini as before. */
function generateTextRouted(prompt: string, maxTokens?: number): Promise<string> {
  return isGroqConfigured() ? generateTextWithGroq(prompt, maxTokens) : generateText(prompt, maxTokens);
}

function generateTextRoutedWithFinish(prompt: string, maxTokens?: number): Promise<{ text: string; truncated: boolean }> {
  return isGroqConfigured() ? generateTextWithGroqFinish(prompt, maxTokens) : generateTextWithFinish(prompt, maxTokens);
}

/**
 * Generates text that may legitimately run past a single response's length
 * limit: if the model stopped only because it hit the token cap (not
 * because it was actually finished), this sends the accumulated text back
 * and asks it to continue exactly where it left off, up to a few rounds.
 */
async function generateLongText(prompt: string, maxTokens: number): Promise<string> {
  let full = '';
  let currentPrompt = prompt;

  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    const { text, truncated } = await generateTextRoutedWithFinish(currentPrompt, maxTokens);
    full += (full && text ? '\n' : '') + text;
    if (!truncated) break;

    currentPrompt =
      `${prompt}\n\n` +
      `You already wrote the following so far (do not repeat any of it, do not re-summarize it, just keep going ` +
      `exactly from where it stops - if it ends mid-sentence, complete that sentence first):\n\n${full}`;
  }

  return full;
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

export interface MarkedMoment {
  offsetSec: number;
  text: string;
}

function buildPrompt(
  transcript: TranscriptSegment[],
  slides: SlideEntry[],
  markedMoments: MarkedMoment[] = [],
  detailLevel: NotesDetailLevel = 'concise'
): string {
  const transcriptText = transcript
    .map((seg) => `[${formatTimestamp(seg.startSec)}] ${seg.text}`)
    .join('\n');

  const slidesText = slides
    .map((slide) => `[${formatTimestamp(slide.offsetSec)}] ${slide.content}`)
    .join('\n\n');

  const markedText = markedMoments
    .map((m) => `[${formatTimestamp(m.offsetSec)}] ${m.text}`)
    .join('\n');

  const styleInstructions =
    detailLevel === 'detailed'
      ? `- Write a thorough, comprehensive writeup, not a compressed summary - aim for something on the order of a 10-page document if the lecture material supports it. Go section by section and actually explain each point in full sentences and paragraphs (not just short bullet fragments), keeping the reasoning, examples, and context the speaker gave rather than trimming them away.
- Still use "## " headings to organize sections and bullet lists where they genuinely help (e.g. enumerations, step lists), but don't compress explanations that deserve real paragraphs down to a single bullet line.
- Do not pad with filler or repeat yourself just to be longer - length should come from genuinely covering everything in the transcript in depth, not from padding.`
      : `- Use bullet points for key ideas, not full transcript sentences.
- Skip filler, small talk, and repeated words from the speech.`;

  return `You are taking structured notes for a university lecture. Below is a raw speech transcript with timestamps, and the content of the slides shown during the lecture.

Produce a clean, well-organized markdown lecture summary:
- Group the material under "## " topic headings inferred from the content.
${styleInstructions}
- Bold important terms and definitions.
- Include a "[mm:ss]" timestamp next to each bullet/section pointing to where it was discussed.
- If slide content and speech overlap, merge them instead of duplicating.
- Write the notes in the same language the transcript is in - do not translate to English or any other language.
- Write any mathematical/physical/financial formulas as LaTeX: "$...$" for an inline expression, "$$...$$" on its own for a standalone/display formula. Don't approximate formulas as plain text or ASCII art when the transcript or slides contain real notation.
${markedMoments.length > 0 ? '- The student flagged some moments as important while recording (list below) - make sure each one is reflected in the notes, marked with "⭐" at the start of that bullet/section.' : ''}

TRANSCRIPT:
${transcriptText || '(no speech transcribed yet)'}

SLIDES:
${slidesText || '(no slides captured yet)'}

MOMENTS THE STUDENT FLAGGED AS IMPORTANT:
${markedText || '(none)'}

Write only the markdown notes, no preamble.`;
}

export async function buildLectureNotes(
  transcript: TranscriptSegment[],
  slides: SlideEntry[],
  markedMoments: MarkedMoment[] = [],
  detailLevel: NotesDetailLevel = 'concise'
): Promise<string> {
  const prompt = buildPrompt(transcript, slides, markedMoments, detailLevel);
  return detailLevel === 'detailed' ? generateLongText(prompt, DETAILED_MAX_TOKENS) : generateTextRouted(prompt);
}

const QUIZ_PROMPT_PREFIX =
  'Ты помогаешь студенту подготовиться к зачёту по его собственному конспекту лекции. ' +
  'На основе конспекта ниже составь короткую самопроверку: 4-6 вопросов (можно смешивать открытые ' +
  'вопросы и вопросы с вариантами ответов). Не пиши ответы сразу под вопросами - вынеси все ответы ' +
  'отдельным списком в самом конце, под заголовком "## Ответы". Формулы пиши в LaTeX ($...$ или $$...$$). ' +
  'Пиши по-русски, в markdown, без преамбулы.\n\n' +
  'КОНСПЕКТ:\n';

/** A short self-check quiz generated from a saved lecture's notes - available any time after saving, not just once. */
export function generateQuizFromNotes(markdown: string): Promise<string> {
  return generateTextRouted(QUIZ_PROMPT_PREFIX + (markdown.trim() || '(конспект пуст)'));
}

const FLASHCARD_PROMPT_PREFIX =
  'На основе конспекта лекции ниже составь набор карточек для запоминания (вопрос-ответ), от 8 до 15 штук ' +
  'в зависимости от объёма материала - по одному ключевому факту, определению или понятию на карточку, ' +
  'коротко и конкретно, без длинных объяснений на обратной стороне. Пиши на том же языке, что и конспект. ' +
  'Формулы пиши в LaTeX ($...$ или $$...$$), не забывая правильно экранировать обратные слэши внутри JSON-строк. ' +
  'Ответь СТРОГО валидным JSON-массивом объектов вида {"front": "...", "back": "..."} и больше ничего - ' +
  'ни преамбулы, ни markdown-разметки, ни обратных кавычек.\n\nКОНСПЕКТ:\n';

export interface FlashcardPair {
  front: string;
  back: string;
}

/** Models sometimes wrap the JSON in a ```json fence or add a stray sentence despite instructions not to - this survives both. */
function parseFlashcardPairs(raw: string): FlashcardPair[] {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  const jsonText = match ? match[0] : cleaned;
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is FlashcardPair => Boolean(p) && typeof p.front === 'string' && typeof p.back === 'string')
      .map((p) => ({ front: p.front.trim(), back: p.back.trim() }))
      .filter((p) => p.front && p.back);
  } catch {
    return [];
  }
}

/** Generates front/back flashcard pairs from a saved lecture's notes - the caller (main.ts) turns these into scheduled Flashcard records. */
export async function generateFlashcardPairsFromNotes(markdown: string): Promise<FlashcardPair[]> {
  const raw = await generateTextRouted(FLASHCARD_PROMPT_PREFIX + (markdown.trim() || '(конспект пуст)'));
  return parseFlashcardPairs(raw);
}
