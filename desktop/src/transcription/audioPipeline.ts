import { buildWavBuffer } from './wav';
import { transcribeAudioChunk } from '../gemini/transcribe';

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface AudioPipelineOptions {
  onSegment: (segment: TranscriptSegment) => void;
  onError: (error: Error) => void;
}

/**
 * Consumes raw PCM audio chunks as they arrive from the extension and sends
 * each one to Gemini for transcription, one at a time (queued) so requests
 * never race each other or blow past the free-tier rate limit.
 */
export class AudioPipeline {
  private queue: Array<{ pcm: Buffer; startOffsetSec: number; durationSec: number }> = [];
  private processing = false;

  constructor(private options: AudioPipelineOptions) {}

  enqueueChunk(pcmBase64: string, startOffsetSec: number, durationSec: number): void {
    const pcm = Buffer.from(pcmBase64, 'base64');
    // Silence filter: skip near-silent chunks so we don't burn free-tier
    // requests (and quota) transcribing dead air.
    if (isSilent(pcm)) return;

    this.queue.push({ pcm, startOffsetSec, durationSec });
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      try {
        const text = await transcribeAudioChunk(buildWavBuffer(chunk.pcm));
        if (text) {
          this.options.onSegment({
            startSec: chunk.startOffsetSec,
            endSec: chunk.startOffsetSec + chunk.durationSec,
            text,
          });
        }
      } catch (err) {
        this.options.onError(err as Error);
      }
    }

    this.processing = false;
  }

  /**
   * Resolves once every enqueued chunk has actually been transcribed.
   * Call this before reading segments for a final notes build - enqueuing a
   * chunk only schedules the Gemini call, it doesn't wait for it, so
   * finalizing right after "stop" would otherwise race the last chunk(s).
   *
   * Capped at 60s: each individual Gemini call already times out on its own
   * (see geminiClient.ts), but this is a second safety net so a lecture can
   * never fail to save at all just because transcription got stuck.
   */
  async waitForIdle(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while ((this.processing || this.queue.length > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Very cheap RMS-based silence check to avoid wasting a Gemini call. */
function isSilent(pcm: Buffer, threshold = 200): boolean {
  if (pcm.length < 2) return true;
  let sumSquares = 0;
  const sampleCount = pcm.length / 2;
  for (let i = 0; i < pcm.length; i += 2) {
    const sample = pcm.readInt16LE(i);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / sampleCount);
  return rms < threshold;
}
