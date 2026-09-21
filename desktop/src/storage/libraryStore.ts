import * as fs from 'fs';
import * as path from 'path';

export interface LectureMeta {
  folderName: string;
  subject: string;
  title: string;
  sourceUrl: string;
  date: string; // ISO
  durationSec: number;
  // True when notes.md currently holds the raw-transcript fallback because
  // the Gemini notes-building call failed at record time, not an actual
  // conspect - lets the UI offer/auto-trigger a rebuild instead of treating
  // the dump as the final result.
  notesFailed?: boolean;
}

export interface RawTranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface RawSlideEntry {
  offsetSec: number;
  content: string;
  source: 'text' | 'vision' | 'file';
}

export interface LectureRawMaterial {
  transcript: RawTranscriptSegment[];
  slides: RawSlideEntry[];
}

/** Strips characters that are illegal in Windows folder names. */
function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || 'Без названия';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function metaPath(dir: string): string {
  return path.join(dir, 'meta.json');
}

function notesPath(dir: string): string {
  return path.join(dir, 'notes.md');
}

function rawPath(dir: string): string {
  return path.join(dir, 'raw.json');
}

export function ensureLibraryRoot(libraryPath: string): void {
  fs.mkdirSync(libraryPath, { recursive: true });
}

export function listSubjects(libraryPath: string): string[] {
  ensureLibraryRoot(libraryPath);
  // DEFAULT_SUBJECT ("Без предмета") is only a fallback folder name for a
  // lecture saved without picking a subject first (see saveLecture) - it
  // used to always show up here too, as a phantom entry with no real
  // directory behind it, which made renaming/deleting it fail (nothing on
  // disk to rename). Now it only appears once something is actually saved
  // there, exactly like any other subject the user creates.
  return fs
    .readdirSync(libraryPath, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

export function createSubject(libraryPath: string, name: string): string {
  const safeName = sanitizeName(name);
  fs.mkdirSync(path.join(libraryPath, safeName), { recursive: true });
  return safeName;
}

export function renameSubject(libraryPath: string, oldName: string, newName: string): string {
  const safeNew = sanitizeName(newName);
  const oldDir = path.join(libraryPath, oldName);
  const newDir = path.join(libraryPath, safeNew);
  if (oldDir !== newDir) fs.renameSync(oldDir, newDir);
  return safeNew;
}

export function deleteSubject(libraryPath: string, name: string): void {
  fs.rmSync(path.join(libraryPath, name), { recursive: true, force: true });
}

export function listLectures(libraryPath: string, subject: string): LectureMeta[] {
  const subjectDir = path.join(libraryPath, subject);
  if (!fs.existsSync(subjectDir)) return [];

  const folders = fs.readdirSync(subjectDir, { withFileTypes: true }).filter((e) => e.isDirectory());

  return folders
    .map((folder) => readMeta(subjectDir, folder.name, subject))
    .filter((m): m is LectureMeta => m !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Every lecture's notes in a subject, concatenated for the AI chat's context (one lecture is just this with one entry). */
export function buildChatContext(libraryPath: string, subject: string, onlyFolderName?: string): string {
  const lectures = listLectures(libraryPath, subject).filter((l) => !onlyFolderName || l.folderName === onlyFolderName);

  return lectures
    .map((lecture) => {
      const markdown = loadLectureMarkdown(libraryPath, subject, lecture.folderName);
      const date = new Date(lecture.date).toLocaleDateString('ru-RU');
      return `## ${lecture.title} (${date})\n\n${markdown}`;
    })
    .join('\n\n---\n\n');
}

/** Every lecture across every subject - the default "just ask" chat needs no folder picked first. */
export function buildFullLibraryContext(libraryPath: string): string {
  return listSubjects(libraryPath)
    .map((subject) => {
      const body = buildChatContext(libraryPath, subject);
      return body ? `# Предмет: ${subject}\n\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n===\n\n');
}

/** Searches lecture titles across every subject (case-insensitive substring match). */
export function searchLectures(libraryPath: string, query: string): LectureMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const results: LectureMeta[] = [];
  for (const subject of listSubjects(libraryPath)) {
    for (const lecture of listLectures(libraryPath, subject)) {
      if (lecture.title.toLowerCase().includes(q) || subject.toLowerCase().includes(q)) {
        results.push(lecture);
      }
    }
  }
  return results.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function readMeta(subjectDir: string, folderName: string, subject: string): LectureMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(path.join(subjectDir, folderName)), 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      folderName,
      subject,
      title: parsed.title ?? folderName,
      sourceUrl: parsed.sourceUrl ?? '',
      date: parsed.date ?? new Date(0).toISOString(),
      durationSec: parsed.durationSec ?? 0,
      notesFailed: Boolean(parsed.notesFailed),
    };
  } catch {
    return null;
  }
}

export function saveLecture(
  libraryPath: string,
  subject: string,
  params: {
    title: string;
    sourceUrl: string;
    durationSec: number;
    markdown: string;
    notesFailed?: boolean;
    raw?: LectureRawMaterial;
  }
): LectureMeta {
  const date = new Date();
  const folderName = `${date.toISOString().slice(0, 10)}-${slugify(params.title) || 'lecture'}`;
  const dir = path.join(libraryPath, subject, folderName);
  fs.mkdirSync(dir, { recursive: true });

  const meta = {
    title: sanitizeName(params.title),
    sourceUrl: params.sourceUrl,
    date: date.toISOString(),
    durationSec: params.durationSec,
    notesFailed: Boolean(params.notesFailed),
  };

  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), 'utf-8');
  fs.writeFileSync(notesPath(dir), params.markdown, 'utf-8');
  if (params.raw) fs.writeFileSync(rawPath(dir), JSON.stringify(params.raw), 'utf-8');

  return { folderName, subject, ...meta };
}

export function loadLectureMarkdown(libraryPath: string, subject: string, folderName: string): string {
  return fs.readFileSync(notesPath(path.join(libraryPath, subject, folderName)), 'utf-8');
}

/** Overwrites just the markdown body - used when the user edits a note by hand, or after a notes rebuild. */
export function saveLectureMarkdown(
  libraryPath: string,
  subject: string,
  folderName: string,
  markdown: string,
  notesFailed = false
): void {
  const dir = path.join(libraryPath, subject, folderName);
  fs.writeFileSync(notesPath(dir), markdown, 'utf-8');
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf-8'));
    meta.notesFailed = notesFailed;
    fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), 'utf-8');
  } catch {
    // meta.json missing/corrupt - the markdown write above still succeeded.
  }
}

/**
 * The original transcript/slides behind a saved lecture, if this app version
 * kept them (older lectures saved before this feature existed won't have
 * one) - lets the "original recording" view and notes-rebuild work from the
 * real source material instead of re-parsing the rendered markdown.
 */
export function loadLectureRaw(libraryPath: string, subject: string, folderName: string): LectureRawMaterial | null {
  try {
    const raw = fs.readFileSync(rawPath(path.join(libraryPath, subject, folderName)), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Adds a new recording's content onto the end of an existing lecture instead
 * of creating a new one. If that lecture folder is somehow gone (deleted
 * mid-recording, moved, etc.), falls back to saving as a fresh lecture
 * instead of throwing and losing the recording entirely.
 */
export function appendToLecture(
  libraryPath: string,
  subject: string,
  folderName: string,
  additionalMarkdown: string,
  additionalDurationSec: number,
  fallbackTitle: string,
  notesFailed = false,
  additionalRaw?: LectureRawMaterial
): LectureMeta {
  const dir = path.join(libraryPath, subject, folderName);
  if (!fs.existsSync(metaPath(dir)) || !fs.existsSync(notesPath(dir))) {
    return saveLecture(libraryPath, subject, {
      title: fallbackTitle,
      sourceUrl: '',
      durationSec: additionalDurationSec,
      markdown: additionalMarkdown,
      notesFailed,
      raw: additionalRaw,
    });
  }

  const meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf-8'));
  const previousDurationSec = meta.durationSec ?? 0;
  meta.durationSec = previousDurationSec + additionalDurationSec;
  meta.notesFailed = notesFailed;
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), 'utf-8');

  const existing = fs.readFileSync(notesPath(dir), 'utf-8');
  const timestamp = new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const combined = `${existing}\n\n---\n\n## Продолжение записи (${timestamp})\n\n${additionalMarkdown}`;
  fs.writeFileSync(notesPath(dir), combined, 'utf-8');

  if (additionalRaw) {
    const previousRaw = loadLectureRaw(libraryPath, subject, folderName) ?? { transcript: [], slides: [] };
    // Offset the new session's timestamps so a full rebuild's "[mm:ss]" refs
    // still point somewhere sensible across the combined recording.
    const combinedRaw: LectureRawMaterial = {
      transcript: [
        ...previousRaw.transcript,
        ...additionalRaw.transcript.map((s) => ({
          ...s,
          startSec: s.startSec + previousDurationSec,
          endSec: s.endSec + previousDurationSec,
        })),
      ],
      slides: [
        ...previousRaw.slides,
        ...additionalRaw.slides.map((s) => ({ ...s, offsetSec: s.offsetSec + previousDurationSec })),
      ],
    };
    fs.writeFileSync(rawPath(dir), JSON.stringify(combinedRaw), 'utf-8');
  }

  return { folderName, subject, ...meta };
}

export function renameLecture(libraryPath: string, subject: string, folderName: string, newTitle: string): void {
  const dir = path.join(libraryPath, subject, folderName);
  const raw = fs.readFileSync(metaPath(dir), 'utf-8');
  const meta = JSON.parse(raw);
  meta.title = sanitizeName(newTitle);
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), 'utf-8');
}

export function deleteLecture(libraryPath: string, subject: string, folderName: string): void {
  fs.rmSync(path.join(libraryPath, subject, folderName), { recursive: true, force: true });
}
