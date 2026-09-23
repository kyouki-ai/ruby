import { generateText, generateTextWithFinish, isApiKeyConfigured } from './geminiClient';
import { generateTextWithGroq, generateTextWithGroqFinish, isGroqConfigured } from '../groq/groqClient';
import {
  generateTextWithCloudflare,
  generateTextWithCloudflareFinish,
  isCloudflareConfigured,
} from '../cloudflare/cloudflareClient';
import { tryProviders } from '../ai/providerChain';
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
// "Кратко" is a shorter target, not an excuse to skip the same safety net -
// a long lecture's concise summary can still legitimately run past whatever
// a given provider/model defaults to (and some auto-picked free-tier models
// cap a single response at only a few hundred tokens), which previously cut
// the notes off mid-sentence with no way to recover the rest.
const CONCISE_MAX_TOKENS = 3000;
const MAX_CONTINUATIONS = 5;
// The tail, not the whole accumulated document, is resent on each continuation
// round - the model only needs to see where it left off to keep going. Without
// this cap, round N's prompt embeds all of rounds 1..N-1's output on top of the
// (already large) transcript, so the request itself can blow past the model's
// context window well before MAX_CONTINUATIONS is reached.
const MAX_CONTINUATION_TAIL_CHARS = 6000;

/**
 * Tries Groq first (when configured, see groqClient.ts), then Gemini, then
 * Cloudflare Workers AI (see cloudflareClient.ts) - each is a separate free
 * account with its own independent quota, so a rate limit or outage on one
 * doesn't fail the request as long as another is configured. Falls straight
 * to whichever of these the user actually set up if not all three are.
 */
function generateTextRouted(prompt: string, maxTokens?: number): Promise<string> {
  return tryProviders([
    { name: 'Groq', configured: isGroqConfigured(), call: () => generateTextWithGroq(prompt, maxTokens) },
    { name: 'Gemini', configured: isApiKeyConfigured(), call: () => generateText(prompt, maxTokens) },
    { name: 'Cloudflare', configured: isCloudflareConfigured(), call: () => generateTextWithCloudflare(prompt, maxTokens) },
  ]);
}

function generateTextRoutedWithFinish(prompt: string, maxTokens?: number): Promise<{ text: string; truncated: boolean }> {
  return tryProviders([
    { name: 'Groq', configured: isGroqConfigured(), call: () => generateTextWithGroqFinish(prompt, maxTokens) },
    { name: 'Gemini', configured: isApiKeyConfigured(), call: () => generateTextWithFinish(prompt, maxTokens) },
    {
      name: 'Cloudflare',
      configured: isCloudflareConfigured(),
      call: () => generateTextWithCloudflareFinish(prompt, maxTokens),
    },
  ]);
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

    const tail = full.length > MAX_CONTINUATION_TAIL_CHARS ? full.slice(-MAX_CONTINUATION_TAIL_CHARS) : full;
    currentPrompt =
      `${prompt}\n\n` +
      `You already wrote the notes up to this point (below is just the tail end of what you wrote so far, not the ` +
      `whole thing - do not repeat any of it, just keep going exactly from where it stops; if it ends mid-sentence, ` +
      `complete that sentence first):\n\n${tail}`;
  }

  return full;
}

export function formatTimestamp(sec: number): string {
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

// A per-chunk response only ever has to cover a couple of minutes of speech,
// so it should basically never need the continuation loop - this is a safety
// net, not the expected path.
const CHUNK_MAX_TOKENS = 2000;

function buildChunkPrompt(
  transcript: TranscriptSegment[],
  slides: SlideEntry[],
  markedMoments: MarkedMoment[],
  isFirstChunk: boolean,
  languageAnchor: string | null
): string {
  const transcriptText = transcript.map((seg) => `[${formatTimestamp(seg.startSec)}] ${seg.text}`).join('\n');
  const slidesText = slides.map((slide) => `[${formatTimestamp(slide.offsetSec)}] ${slide.content}`).join('\n\n');
  const markedText = markedMoments.map((m) => `[${formatTimestamp(m.offsetSec)}] ${m.text}`).join('\n');

  // Each chunk is transcribed independently, and a short chunk occasionally
  // comes back mistranscribed into the wrong language entirely (audio
  // quality, an accent, a whisper-model glitch) - with no surrounding
  // context to correct against the way a whole-transcript build would have,
  // "write in the same language as the transcript" then produces a chunk of
  // notes in the WRONG language, breaking consistency with the rest of the
  // document. Anchoring to a confirmed-correct excerpt from earlier in this
  // same lecture avoids that: the anchor's language wins even if the new
  // segment below looks like a different language.
  const languageInstruction = languageAnchor
    ? `Write in the same language as this confirmed excerpt from earlier in the same lecture: "${languageAnchor}" - if the new segment below looks like a different language, that is a transcription glitch, not a real language change; write your notes in the anchor's language regardless.`
    : 'Write in the same language as the transcript below - do not translate.';

  return `You are taking structured, detailed lecture notes LIVE while the lecture is still being recorded - you only ever see one new short segment of speech at a time, never the whole lecture at once.

${
  isFirstChunk
    ? 'This is the FIRST segment of the lecture.'
    : "This is the NEXT segment, continuing directly after material you already wrote notes for (which you can no longer see) - do not reintroduce the lecture, do not summarize what came before, just keep documenting from here as if this were the next part of the same ongoing document."
}

Write a thorough writeup of just THIS segment - full sentences and paragraphs, not compressed bullet fragments, keeping the reasoning/examples/context the speaker gave. Use "## " headings only for a genuinely NEW topic that starts within this segment - if it's a continuation of the same topic as before, don't add a heading, just keep writing under it. Bold important terms/definitions. Include a "[mm:ss]" timestamp next to each bullet/section. Write formulas as LaTeX ($...$ or $$...$$). ${languageInstruction}
${markedMoments.length > 0 ? '- The student flagged some moments in this segment as important - mark each with "⭐" at the start of that bullet/section.' : ''}

NEW SPEECH SEGMENT:
${transcriptText || '(тишина)'}

NEW SLIDES SEEN DURING THIS SEGMENT:
${slidesText || '(нет)'}

MOMENTS FLAGGED AS IMPORTANT IN THIS SEGMENT:
${markedText || '(none)'}

Write only the markdown continuation - no preamble, no closing remarks, no "in this segment we covered" wrap-up.`;
}

/**
 * Builds notes for just a new slice of an ongoing lecture, mid-recording -
 * not the whole thing (see buildLectureNotes below for that). Always writes
 * in the detailed style: building this incrementally, a couple of minutes at
 * a time, throughout the recording is what makes "Подробно" cheap and fast
 * to finish the instant the user stops, instead of one huge expensive call
 * over the entire transcript at the end. A "Кратко" request afterward can
 * just condense this already-written detailed text instead of reprocessing
 * the raw transcript from scratch.
 *
 * languageAnchor is a confirmed-correct excerpt from earlier in the SAME
 * lecture (see main.ts), used to keep every chunk in the same language even
 * if one chunk's own transcript got mistranscribed into a different one -
 * pass null only for the very first chunk, before any anchor exists yet.
 */
export function buildLectureNotesChunk(
  transcript: TranscriptSegment[],
  slides: SlideEntry[],
  markedMoments: MarkedMoment[],
  isFirstChunk: boolean,
  languageAnchor: string | null
): Promise<string> {
  const prompt = buildChunkPrompt(transcript, slides, markedMoments, isFirstChunk, languageAnchor);
  return generateLongText(prompt, CHUNK_MAX_TOKENS);
}

// A long lecture's raw transcript (plus slide text) can outright exceed a
// Groq model's context window on its own, before the prompt instructions or
// requested output are even counted - Groq then rejects the request itself
// with "Please reduce the length of the messages or completion" rather than
// the usual 429 rate-limit. Same trade-off as capNotesForPrompt below: losing
// some coverage on an unusually long lecture beats failing outright.
const MAX_SOURCE_CHARS_FOR_NOTES = 45000;

function capSourceText(transcriptText: string, slidesText: string): { transcriptText: string; slidesText: string } {
  if (transcriptText.length + slidesText.length <= MAX_SOURCE_CHARS_FOR_NOTES) {
    return { transcriptText, slidesText };
  }
  // Slide text is mostly redundant with what was said about it, so it gets the
  // smaller share of the budget; the spoken transcript is the primary source.
  const slidesBudget = Math.min(slidesText.length, Math.floor(MAX_SOURCE_CHARS_FOR_NOTES * 0.2));
  const transcriptBudget = MAX_SOURCE_CHARS_FOR_NOTES - slidesBudget;
  return {
    transcriptText:
      transcriptText.length > transcriptBudget
        ? transcriptText.slice(0, transcriptBudget) + '\n…(транскрипт обрезан из-за ограничения модели)'
        : transcriptText,
    slidesText:
      slidesText.length > slidesBudget
        ? slidesText.slice(0, slidesBudget) + '\n…(слайды обрезаны из-за ограничения модели)'
        : slidesText,
  };
}

function buildPrompt(
  transcript: TranscriptSegment[],
  slides: SlideEntry[],
  markedMoments: MarkedMoment[] = [],
  detailLevel: NotesDetailLevel = 'concise'
): string {
  const { transcriptText, slidesText } = capSourceText(
    transcript.map((seg) => `[${formatTimestamp(seg.startSec)}] ${seg.text}`).join('\n'),
    slides.map((slide) => `[${formatTimestamp(slide.offsetSec)}] ${slide.content}`).join('\n\n')
  );

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
  return generateLongText(prompt, detailLevel === 'detailed' ? DETAILED_MAX_TOKENS : CONCISE_MAX_TOKENS);
}

// Some auto-picked Groq models (see groqClient.ts's resolveTextModel) have a
// fairly small context window - a long "Подробно" conspect (up to ~10 pages)
// plus the prompt instructions can exceed it outright (a real Groq 400
// "context_length_exceeded", not a guess). Capping the input here trades a
// bit of coverage on a huge conspect for the quiz/flashcards actually being
// generatable at all, instead of failing outright.
const MAX_NOTES_CHARS_FOR_DERIVED_CONTENT = 12000;

function capNotesForPrompt(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed.length <= MAX_NOTES_CHARS_FOR_DERIVED_CONTENT) return trimmed;
  return trimmed.slice(0, MAX_NOTES_CHARS_FOR_DERIVED_CONTENT) + '\n\n…(конспект обрезан из-за ограничения модели)';
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
  return generateTextRouted(QUIZ_PROMPT_PREFIX + (capNotesForPrompt(markdown) || '(конспект пуст)'));
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
  const raw = await generateTextRouted(FLASHCARD_PROMPT_PREFIX + (capNotesForPrompt(markdown) || '(конспект пуст)'));
  return parseFlashcardPairs(raw);
}
