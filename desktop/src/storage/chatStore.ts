import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';

/**
 * Named, persisted chat threads - separate from the lecture library (these
 * live under userData, not the notes folder, since a chat thread isn't a
 * lecture). Previously the whole conversation lived only in the renderer's
 * memory and vanished on every restart; now it's a small JSON file per
 * thread, loaded back on demand.
 */

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface ChatThread {
  id: string;
  title: string;
  // A per-lecture thread (opened via "Чат по лекции") carries both; a
  // general-purpose thread the user names themselves ("ДЗ", "Вопросы") has
  // both null and searches across every subject, like the default chat.
  subject: string | null;
  folderName: string | null;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatThreadMeta {
  id: string;
  title: string;
  subject: string | null;
  folderName: string | null;
  updatedAt: string;
  messageCount: number;
}

function chatsDir(): string {
  const dir = path.join(app.getPath('userData'), 'chats');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function threadPath(id: string): string {
  return path.join(chatsDir(), `${id}.json`);
}

function readThreadFile(filePath: string): ChatThread | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function listChatThreads(): ChatThreadMeta[] {
  const dir = chatsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readThreadFile(path.join(dir, f)))
    .filter((t): t is ChatThread => t !== null)
    .map((t) => ({
      id: t.id,
      title: t.title,
      subject: t.subject,
      folderName: t.folderName,
      updatedAt: t.updatedAt,
      messageCount: t.messages.length,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function createChatThread(
  title: string,
  subject: string | null = null,
  folderName: string | null = null
): ChatThread {
  const thread: ChatThread = {
    id: crypto.randomUUID(),
    title,
    subject,
    folderName,
    updatedAt: new Date().toISOString(),
    messages: [],
  };
  fs.writeFileSync(threadPath(thread.id), JSON.stringify(thread, null, 2), 'utf-8');
  return thread;
}

export function loadChatThread(id: string): ChatThread | null {
  return readThreadFile(threadPath(id));
}

export function saveChatMessages(id: string, messages: ChatMessage[]): void {
  const thread = loadChatThread(id);
  if (!thread) return;
  thread.messages = messages;
  thread.updatedAt = new Date().toISOString();
  fs.writeFileSync(threadPath(id), JSON.stringify(thread, null, 2), 'utf-8');
}

export function renameChatThread(id: string, title: string): void {
  const thread = loadChatThread(id);
  if (!thread) return;
  thread.title = title;
  fs.writeFileSync(threadPath(id), JSON.stringify(thread, null, 2), 'utf-8');
}

export function deleteChatThread(id: string): void {
  fs.rm(threadPath(id), () => undefined);
}

/**
 * "Чат по лекции"/"Чат по предмету" reuses the existing thread for that
 * scope if one exists, instead of creating a duplicate every time it's
 * opened. folderName is null for a subject-wide chat (no single lecture).
 */
export function findOrCreateLectureThread(subject: string, folderName: string | null, title: string): ChatThread {
  const dir = chatsDir();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const thread = readThreadFile(path.join(dir, f));
    if (thread && thread.subject === subject && thread.folderName === folderName) return thread;
  }
  return createChatThread(title, subject, folderName);
}
