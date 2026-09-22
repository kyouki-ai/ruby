import * as crypto from 'crypto';
import { generateWithImage, generateWithDocument } from '../gemini/geminiClient';

export interface SlideEntry {
  offsetSec: number;
  // The page's extracted innerText, a vision-model description when the
  // slide had no usable text layer, or a summary of an attached file.
  content: string;
  source: 'text' | 'vision' | 'file';
}

const VISION_PROMPT =
  'Describe the content of this lecture slide in a few concise bullet points. ' +
  'Focus on titles, key terms, formulas, and any text visible. Ignore decorative elements.';

const PHOTO_PROMPT =
  'This is a photo of a lecture slide, whiteboard, or handwritten notes, shot separately (e.g. on a ' +
  'phone) rather than captured live during the recording. Describe its content in a few concise bullet ' +
  'points: titles, key terms, formulas, and any visible text. Ignore photo artifacts (glare, angle, background).';

/** Describes a single photo attached to an already-saved lecture (not part of the live pipeline above). */
export function describePhoto(base64Data: string, mimeType: string): Promise<string> {
  return generateWithDocument(PHOTO_PROMPT, base64Data, mimeType);
}

const FILE_PROMPT =
  'This is a lecture slide deck. Go through it slide by slide (or page by page) and summarize ' +
  'each one as a short heading plus a few bullet points covering titles, key terms, formulas, and ' +
  'visible text. Keep the original slide order.';

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function hashScreenshot(base64: string): string {
  // Screenshots differ slightly frame to frame (compression noise), so we
  // hash a coarse sample of the base64 string instead of the exact bytes -
  // good enough to catch "same slide, still on screen" duplicates.
  const sample = base64.slice(0, 2000);
  return crypto.createHash('sha1').update(sample).digest('hex');
}

/**
 * Accumulates distinct slides seen during a lecture, filtering out repeats
 * of the same slide across consecutive captures, and falling back to Gemini's
 * vision understanding when a slide carries no extractable text.
 */
export class SlidePipeline {
  private entries: SlideEntry[] = [];
  private lastTextKey: string | null = null;
  private lastScreenshotHash: string | null = null;

  get slides(): SlideEntry[] {
    return this.entries;
  }

  async ingest(params: { offsetSec: number; text: string; screenshotBase64: string }): Promise<SlideEntry | null> {
    const normalizedText = normalize(params.text);

    if (normalizedText.length > 20) {
      if (normalizedText === this.lastTextKey) return null; // same slide as before
      this.lastTextKey = normalizedText;
      this.lastScreenshotHash = null;
      const entry: SlideEntry = { offsetSec: params.offsetSec, content: params.text.trim(), source: 'text' };
      this.entries.push(entry);
      return entry;
    }

    // No usable text layer - dedup by screenshot similarity, then ask Gemini's
    // vision model to describe what's on screen.
    const screenshotHash = hashScreenshot(params.screenshotBase64);
    if (screenshotHash === this.lastScreenshotHash) return null;
    this.lastScreenshotHash = screenshotHash;
    this.lastTextKey = null;

    const description = await generateWithImage(VISION_PROMPT, params.screenshotBase64);

    const entry: SlideEntry = { offsetSec: params.offsetSec, content: description.trim(), source: 'vision' };
    this.entries.push(entry);
    return entry;
  }

  /** Adds a slide deck the user already had on disk (PDF or image) instead of live-capturing it. */
  async ingestFile(offsetSec: number, base64Data: string, mimeType: string): Promise<SlideEntry> {
    const summary = await generateWithDocument(FILE_PROMPT, base64Data, mimeType);
    const entry: SlideEntry = { offsetSec, content: summary.trim(), source: 'file' };
    this.entries.push(entry);
    return entry;
  }
}
