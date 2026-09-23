import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { logError } from './logger';

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
  let encrypted: Buffer;
  try {
    encrypted = fs.readFileSync(keyFilePath());
  } catch {
    return []; // Nothing saved yet - not an error.
  }
  try {
    const decrypted = safeStorage.decryptString(encrypted);
    try {
      const parsed = JSON.parse(decrypted);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Pre-existing save from before multi-key support - a raw key string.
    }
    return decrypted ? [decrypted] : [];
  } catch (err) {
    // A saved key that fails to decrypt was previously treated exactly like
    // "no key saved" with zero trace anywhere - genuinely indistinguishable
    // from a first-time user, which made a real problem here (Windows
    // DPAPI/credential issues, a userData dir moved to another machine, ...)
    // look like the user simply never configured anything.
    logError('Failed to decrypt saved Gemini API key(s) - treating as not configured', err);
    return [];
  }
}

export function clearApiKey(): void {
  fs.rm(keyFilePath(), () => undefined);
}

/**
 * Groq's free Whisper/Llama API is optional - only used for audio
 * transcription and (once configured) notes/chat/quiz too, so a lecture's
 * speech doesn't have to share Gemini's tight free-tier daily quota. Same
 * encrypted-at-rest treatment and the same comma/newline-separated multi-key
 * round-robin as the Gemini key above - Groq's free tier rate-limits tokens
 * per minute per account, so a second free key (a different Groq account)
 * gives the app a fresh quota to fall back to instead of failing outright.
 */
function groqKeyFilePath(): string {
  return path.join(app.getPath('userData'), 'groq-key.enc');
}

export function saveGroqApiKey(rawInput: string): void {
  const keys = parseKeys(rawInput);
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  fs.mkdirSync(path.dirname(groqKeyFilePath()), { recursive: true });
  fs.writeFileSync(groqKeyFilePath(), encrypted);
}

export function loadGroqApiKeys(): string[] {
  let encrypted: Buffer;
  try {
    encrypted = fs.readFileSync(groqKeyFilePath());
  } catch {
    return []; // Nothing saved yet - not an error.
  }
  try {
    const decrypted = safeStorage.decryptString(encrypted);
    try {
      const parsed = JSON.parse(decrypted);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Pre-existing save from before multi-key support - a raw key string.
    }
    return decrypted ? [decrypted] : [];
  } catch (err) {
    logError('Failed to decrypt saved Groq API key(s) - treating as not configured', err);
    return [];
  }
}

export function clearGroqApiKey(): void {
  fs.rm(groqKeyFilePath(), () => undefined);
}

/**
 * Cloudflare Workers AI as a third, last-resort text provider - tried only
 * once both Gemini and Groq have failed a given request (see notesBuilder.ts
 * and chatReply.ts). Unlike Gemini/Groq this needs two pieces (an account ID
 * plus an API token, both from the Cloudflare dashboard, no card required),
 * so it's stored as one JSON object rather than a key list.
 */
function cloudflareCredsFilePath(): string {
  return path.join(app.getPath('userData'), 'cloudflare-creds.enc');
}

export interface CloudflareCredentials {
  accountId: string;
  apiToken: string;
}

export function saveCloudflareCredentials(accountId: string, apiToken: string): void {
  const creds: CloudflareCredentials = { accountId: accountId.trim(), apiToken: apiToken.trim() };
  const encrypted = safeStorage.encryptString(JSON.stringify(creds));
  fs.mkdirSync(path.dirname(cloudflareCredsFilePath()), { recursive: true });
  fs.writeFileSync(cloudflareCredsFilePath(), encrypted);
}

export function loadCloudflareCredentials(): CloudflareCredentials | null {
  let encrypted: Buffer;
  try {
    encrypted = fs.readFileSync(cloudflareCredsFilePath());
  } catch {
    return null; // Nothing saved yet - not an error.
  }
  try {
    const decrypted = safeStorage.decryptString(encrypted);
    const parsed = JSON.parse(decrypted) as CloudflareCredentials;
    return parsed.accountId && parsed.apiToken ? parsed : null;
  } catch (err) {
    logError('Failed to decrypt saved Cloudflare credentials - treating as not configured', err);
    return null;
  }
}

export function clearCloudflareCredentials(): void {
  fs.rm(cloudflareCredsFilePath(), () => undefined);
}
