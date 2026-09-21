import { generateWithAudio } from './geminiClient';

const TRANSCRIBE_PROMPT =
  'This is a ~30-second clip from a university lecture recording, possibly with background ' +
  'noise, room echo, or a speaker who is not close to the microphone. ' +
  'Transcribe the speech verbatim, in its original language (do not translate). ' +
  'Use correct punctuation and spelling, including technical/academic terms - if a term is ' +
  'unclear, transcribe your best guess at the actual word rather than a similar-sounding one. ' +
  'Do not skip or shorten unclear passages - transcribe your best interpretation instead. ' +
  'Output only the transcribed text, no commentary, no timestamps, no notes about audio quality. ' +
  'If there is no speech at all, output nothing.';

/** Sends one ~12s WAV chunk to Gemini and returns the transcribed text (or ''). */
export async function transcribeAudioChunk(wavBase64: string): Promise<string> {
  const text = await generateWithAudio(TRANSCRIBE_PROMPT, wavBase64);
  return text.trim();
}
