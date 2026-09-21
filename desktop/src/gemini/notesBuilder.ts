import { generateText } from './geminiClient';
import { generateTextWithGroq, isGroqConfigured } from '../groq/groqClient';
import { TranscriptSegment } from '../transcription/audioPipeline';
import { SlideEntry } from '../slides/slidePipeline';

/** Routes to Groq when the user configured a key (see groqClient.ts), else Gemini as before. */
function generateTextRouted(prompt: string): Promise<string> {
  return isGroqConfigured() ? generateTextWithGroq(prompt) : generateText(prompt);
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
  markedMoments: MarkedMoment[] = []
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

  return `You are taking structured notes for a university lecture. Below is a raw speech transcript with timestamps, and the content of the slides shown during the lecture.

Produce a clean, well-organized markdown lecture summary:
- Group the material under "## " topic headings inferred from the content.
- Use bullet points for key ideas, not full transcript sentences.
- Bold important terms and definitions.
- Include a "[mm:ss]" timestamp next to each bullet pointing to where it was discussed.
- Skip filler, small talk, and repeated words from the speech.
- If slide content and speech overlap, merge them into one bullet instead of duplicating.
${markedMoments.length > 0 ? '- The student flagged some moments as important while recording (list below) - make sure each one is reflected in the notes, marked with "⭐" at the start of that bullet.' : ''}

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
  markedMoments: MarkedMoment[] = []
): Promise<string> {
  return generateTextRouted(buildPrompt(transcript, slides, markedMoments));
}

const QUIZ_PROMPT_PREFIX =
  'Ты помогаешь студенту подготовиться к зачёту по его собственному конспекту лекции. ' +
  'На основе конспекта ниже составь короткую самопроверку: 4-6 вопросов (можно смешивать открытые ' +
  'вопросы и вопросы с вариантами ответов). Не пиши ответы сразу под вопросами - вынеси все ответы ' +
  'отдельным списком в самом конце, под заголовком "## Ответы". Пиши по-русски, в markdown, без преамбулы.\n\n' +
  'КОНСПЕКТ:\n';

/** A short self-check quiz generated from a saved lecture's notes - available any time after saving, not just once. */
export function generateQuizFromNotes(markdown: string): Promise<string> {
  return generateTextRouted(QUIZ_PROMPT_PREFIX + (markdown.trim() || '(конспект пуст)'));
}
