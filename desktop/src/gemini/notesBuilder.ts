import { generateText } from './geminiClient';
import { TranscriptSegment } from '../transcription/audioPipeline';
import { SlideEntry } from '../slides/slidePipeline';

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}`;
}

function buildPrompt(transcript: TranscriptSegment[], slides: SlideEntry[]): string {
  const transcriptText = transcript
    .map((seg) => `[${formatTimestamp(seg.startSec)}] ${seg.text}`)
    .join('\n');

  const slidesText = slides
    .map((slide) => `[${formatTimestamp(slide.offsetSec)}] ${slide.content}`)
    .join('\n\n');

  return `You are taking structured notes for a university lecture. Below is a raw speech transcript with timestamps, and the content of the slides shown during the lecture.

Produce a clean, well-organized markdown lecture summary:
- Group the material under "## " topic headings inferred from the content.
- Use bullet points for key ideas, not full transcript sentences.
- Bold important terms and definitions.
- Include a "[mm:ss]" timestamp next to each bullet pointing to where it was discussed.
- Skip filler, small talk, and repeated words from the speech.
- If slide content and speech overlap, merge them into one bullet instead of duplicating.

TRANSCRIPT:
${transcriptText || '(no speech transcribed yet)'}

SLIDES:
${slidesText || '(no slides captured yet)'}

Write only the markdown notes, no preamble.`;
}

export async function buildLectureNotes(transcript: TranscriptSegment[], slides: SlideEntry[]): Promise<string> {
  return generateText(buildPrompt(transcript, slides));
}
