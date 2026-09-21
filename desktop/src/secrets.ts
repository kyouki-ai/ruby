import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Stores the user's own Gemini API key(s) encrypted at rest via the OS
 * credential store (Windows DPAPI under the hood), so each person who runs
 * this app pastes in their own free key and it isn't sitting in a plaintext
 * settings file.
 *
 * The Settings field stays a single input - nothing changes for someone who
 * just pastes one key. But if someone hits the free tier's daily limit and
 * happens to have a second free key (a different Google account), pasting
 * both into the same field separated by a comma is enough to round-robin
 * between them - no separate "add another account" UI to deal with.
 */
function keyFilePath(): string {
  return path.join(app.getPath('userData'), 'api-key.enc');
}

function parseKeys(rawInput: string): string[] {
  return rawInput
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

export function saveApiKey(rawInput: string): void {
  const keys = parseKeys(rawInput);
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  fs.mkdirSync(path.dirname(keyFilePath()), { recursive: true });
  fs.writeFileSync(keyFilePath(), encrypted);
}

export function loadApiKeys(): string[] {
  try {
    const encrypted = fs.readFileSync(keyFilePath());
    const decrypted = safeStorage.decryptString(encrypted);
    try {
      const parsed = JSON.parse(decrypted);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Pre-existing save from before multi-key support - a raw key string.
    }
    return decrypted ? [decrypted] : [];
  } catch {
    return [];
  }
}

export function clearApiKey(): void {
  fs.rm(keyFilePath(), () => undefined);
}

/**
 * Groq's free Whisper API is optional - only used for audio transcription
 * (the highest-volume Gemini call) when configured, so a lecture's speech
 * doesn't have to share Gemini's tight free-tier daily quota with notes
 * building, chat and the quiz feature. A single key, same encrypted-at-rest
 * treatment as the Gemini key.
 */
function groqKeyFilePath(): string {
  return path.join(app.getPath('userData'), 'groq-key.enc');
}

export function saveGroqApiKey(rawInput: string): void {
  const key = rawInput.trim();
  const encrypted = safeStorage.encryptString(key);
  fs.mkdirSync(path.dirname(groqKeyFilePath()), { recursive: true });
  fs.writeFileSync(groqKeyFilePath(), encrypted);
}

export function loadGroqApiKey(): string | null {
  try {
    const encrypted = fs.readFileSync(groqKeyFilePath());
    const decrypted = safeStorage.decryptString(encrypted);
    return decrypted || null;
  } catch {
    return null;
  }
}

export function clearGroqApiKey(): void {
  fs.rm(groqKeyFilePath(), () => undefined);
}
