import { generateWithAudio } from './geminiClient';
import { transcribeWithGroq, isGroqConfigured } from '../groq/groqClient';

const TRANSCRIBE_PROMPT =
  'This is a ~30-second clip from a university lecture recording, possibly with background ' +
  'noise, room echo, or a speaker who is not close to the microphone. ' +
  'Transcribe the speech verbatim, in its original language (do not translate). ' +
  'Use correct punctuation and spelling, including technical/academic terms - if a term is ' +
  'unclear, transcribe your best guess at the actual word rather than a similar-sounding one. ' +
  'Do not skip or shorten unclear passages - transcribe your best interpretation instead. ' +
  'Output only the transcribed text, no commentary, no timestamps, no notes about audio quality. ' +
  'If there is no speech at all, output nothing.';

/**
 * Sends one ~30s WAV chunk off for transcription and returns the text (or
 * '' for silence). Goes to Groq's free Whisper API when the user configured
 * one (see groqClient.ts for why), otherwise falls back to Gemini exactly
 * as before - configuring Groq is optional, not a second required key.
 */
export async function transcribeAudioChunk(wavBuffer: Buffer): Promise<string> {
  const text = isGroqConfigured()
    ? await transcribeWithGroq(wavBuffer)
    : await generateWithAudio(TRANSCRIBE_PROMPT, wavBuffer.toString('base64'));
  return text.trim();
}
