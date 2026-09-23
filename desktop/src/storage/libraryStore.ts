import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AssignmentEntry } from '../assignments/assignmentDetector';

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
  // References a SubjectMeta.groups[].id - absent/dangling (group deleted)
  // means the card renders in the subject's "ungrouped" area. Groups are
  // free-form (user names them "Лекция", "Практика", "Лабораторная", ...)
  // rather than a fixed enum, so this is a plain string, not a union type.
  groupId?: string;
  // Manual drag-and-drop position (within a group, or within "ungrouped").
  // Uses fractional/midpoint insertion so moving one card only ever
  // rewrites that one card's meta.json - see setLecturePosition.
  order: number;
}

export interface LectureGroup {
  id: string;
  name: string;
}

export interface SubjectMeta {
  groups: LectureGroup[];
}

function subjectMetaPath(libraryPath: string, subject: string): string {
  return path.join(libraryPath, subject, 'subject.json');
}

export function loadSubjectMeta(libraryPath: string, subject: string): SubjectMeta {
  try {
    const raw = fs.readFileSync(subjectMetaPath(libraryPath, subject), 'utf-8');
    const parsed = JSON.parse(raw);
    const groups: LectureGroup[] = Array.isArray(parsed.groups)
      ? parsed.groups
          .filter((g: unknown): g is { id: unknown; name: unknown } => typeof g === 'object' && g !== null)
          .filter((g: { id: unknown; name: unknown }) => typeof g.id === 'string' && typeof g.name === 'string')
          .map((g: { id: string; name: string }) => ({ id: g.id, name: g.name }))
      : [];
    return { groups };
  } catch {
    return { groups: [] };
  }
}

export function saveSubjectMeta(libraryPath: string, subject: string, meta: SubjectMeta): void {
  fs.mkdirSync(path.join(libraryPath, subject), { recursive: true });
  fs.writeFileSync(subjectMetaPath(libraryPath, subject), JSON.stringify(meta, null, 2), 'utf-8');
}

/** Creates a new named group ("Лекция", "Практика", "Лабораторная", or anything else the user types). */
export function createLectureGroup(libraryPath: string, subject: string, name: string): LectureGroup {
  const meta = loadSubjectMeta(libraryPath, subject);
  const group: LectureGroup = { id: randomUUID(), name: sanitizeName(name) };
  meta.groups.push(group);
  saveSubjectMeta(libraryPath, subject, meta);
  return group;
}

export function renameLectureGroup(libraryPath: string, subject: string, groupId: string, newName: string): void {
  const meta = loadSubjectMeta(libraryPath, subject);
  const group = meta.groups.find((g) => g.id === groupId);
  if (group) group.name = sanitizeName(newName);
  saveSubjectMeta(libraryPath, subject, meta);
}

/** Lectures that referenced this group simply fall back to "ungrouped" - their groupId is left dangling but harmless. */
export function deleteLectureGroup(libraryPath: string, subject: string, groupId: string): void {
  const meta = loadSubjectMeta(libraryPath, subject);
  meta.groups = meta.groups.filter((g) => g.id !== groupId);
  saveSubjectMeta(libraryPath, subject, meta);
}

export function reorderLectureGroups(libraryPath: string, subject: string, orderedGroupIds: string[]): void {
  const meta = loadSubjectMeta(libraryPath, subject);
  const byId = new Map(meta.groups.map((g) => [g.id, g]));
  meta.groups = orderedGroupIds.map((id) => byId.get(id)).filter((g): g is LectureGroup => Boolean(g));
  saveSubjectMeta(libraryPath, subject, meta);
}

/** Persists a drag-and-drop move: which group a lecture card now belongs to (null = ungrouped) and its position there. */
export function setLecturePosition(
  libraryPath: string,
  subject: string,
  folderName: string,
  groupId: string | null,
  order: number
): void {
  const dir = path.join(libraryPath, subject, folderName);
  const meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf-8'));
  if (groupId) meta.groupId = groupId;
  else delete meta.groupId;
  meta.order = order;
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), 'utf-8');
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
  // Absent on lectures saved before this feature existed.
  assignments?: AssignmentEntry[];
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

export interface LibraryStats {
  subjectCount: number;
  lectureCount: number;
  totalDurationSec: number;
  lastActivityDate: string | null;
}

/** Aggregate counts for the "Мои предметы" dashboard - purely local, no extra Gemini calls. */
export function getLibraryStats(libraryPath: string): LibraryStats {
  const subjects = listSubjects(libraryPath);
  let lectureCount = 0;
  let totalDurationSec = 0;
  let lastActivityDate: string | null = null;

  for (const subject of subjects) {
    for (const lecture of listLectures(libraryPath, subject)) {
      lectureCount++;
      totalDurationSec += lecture.durationSec;
      if (!lastActivityDate || lecture.date > lastActivityDate) lastActivityDate = lecture.date;
    }
  }

  return { subjectCount: subjects.length, lectureCount, totalDurationSec, lastActivityDate };
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

export interface SearchResults {
  subjects: string[];
  // matchSnippet is only set when the hit came from the note body, not the
  // title/subject (which the UI already shows plainly) - gives the user a
  // clue why an otherwise-unrelated-looking title matched.
  lectures: (LectureMeta & { matchSnippet?: string })[];
}

/** A short excerpt around the first match, for search hits that come from the note body rather than the title. */
function extractSnippet(text: string, query: string, radius = 60): string {
  const idx = text.toLowerCase().indexOf(query);
  if (idx === -1) return '';
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + excerpt + (end < text.length ? '…' : '');
}

/**
 * Searches lecture titles and subject names (case-insensitive substring
 * match). Subjects are matched and returned separately from lectures - a
 * subject with zero lectures in it can't show up as a lecture result (there
 * is no lecture to represent it), so without this a brand-new empty subject
 * would be unfindable by search even though it's right there in the grid.
 */
export function searchLibrary(libraryPath: string, query: string): SearchResults {
  const q = query.trim().toLowerCase();
  if (!q) return { subjects: [], lectures: [] };

  const allSubjects = listSubjects(libraryPath);
  const subjects = allSubjects.filter((s) => s.toLowerCase().includes(q));

  const lectures: (LectureMeta & { matchSnippet?: string })[] = [];
  for (const subject of allSubjects) {
    for (const lecture of listLectures(libraryPath, subject)) {
      if (lecture.title.toLowerCase().includes(q) || subject.toLowerCase().includes(q)) {
        lectures.push(lecture);
        continue;
      }
      // Falls back to the note body itself - a title-only search misses
      // anything that was actually discussed but didn't make the heading.
      try {
        const markdown = loadLectureMarkdown(libraryPath, subject, lecture.folderName);
        if (markdown.toLowerCase().includes(q)) {
          lectures.push({ ...lecture, matchSnippet: extractSnippet(markdown, q) });
        }
      } catch {
        // notes.md missing/unreadable - just isn't a body-text match.
      }
    }
  }
  lectures.sort((a, b) => (a.date < b.date ? 1 : -1));

  return { subjects, lectures };
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
      groupId: typeof parsed.groupId === 'string' ? parsed.groupId : undefined,
      order: typeof parsed.order === 'number' ? parsed.order : new Date(parsed.date ?? 0).getTime(),
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
    groupId?: string;
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
    groupId: params.groupId,
    order: Date.now(),
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

/** Overwrites the raw transcript/slides material - used after attaching a photo to an already-saved lecture. */
export function saveLectureRaw(libraryPath: string, subject: string, folderName: string, raw: LectureRawMaterial): void {
  fs.writeFileSync(rawPath(path.join(libraryPath, subject, folderName)), JSON.stringify(raw), 'utf-8');
}

function sessionRecoveryPath(dir: string): string {
  return path.join(dir, 'session-recovery.json');
}

/**
 * Periodic crash-safety snapshot of a recording still in progress - a
 * SEPARATE file from raw.json/notes.md, written every minute or so while
 * recording (see main.ts's autosaveTick), on purpose never touching those
 * real files until the session actually finishes. Overwriting raw.json/
 * notes.md mid-session would be safe for a brand-new lecture's own folder,
 * but not for one that's continuing an already-finished lecture ("Лекция"
 * dropdown / a calendar-scheduled placeholder) - appendToLecture's merge
 * with the PRIOR session's content only happens once, at the end, so
 * writing the real files early would silently blow that prior content away
 * until the merge caught up. A crash/restart before that merge now leaves
 * this file lying around instead of losing the recording outright, even
 * without an automatic recovery flow yet.
 */
export function saveSessionRecovery(
  libraryPath: string,
  subject: string,
  folderName: string,
  data: { markdown: string; raw: LectureRawMaterial }
): void {
  const dir = path.join(libraryPath, subject, folderName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionRecoveryPath(dir), JSON.stringify(data), 'utf-8');
}

/** Called once a session finishes normally - the snapshot above is now redundant. */
export function clearSessionRecovery(libraryPath: string, subject: string, folderName: string): void {
  fs.rm(sessionRecoveryPath(path.join(libraryPath, subject, folderName)), () => undefined);
}

/**
 * Finalizes a lecture folder that was created at the start of its OWN
 * recording session (see startNewSession), once that session ends - a plain
 * overwrite of title/duration/notes/raw. Deliberately NOT the same as
 * appendToLecture's "## Продолжение записи" merge below: that merge is for
 * a genuinely separate, later session continuing an already-finished
 * lecture, whereas this is the first and only save for a folder nothing
 * else has ever written real content into yet.
 */
export function finalizeLiveLecture(
  libraryPath: string,
  subject: string,
  folderName: string,
  params: {
    title: string;
    sourceUrl: string;
    durationSec: number;
    markdown: string;
    notesFailed?: boolean;
    raw?: LectureRawMaterial;
  }
): LectureMeta {
  const dir = path.join(libraryPath, subject, folderName);
  const meta = JSON.parse(fs.readFileSync(metaPath(dir), 'utf-8'));
  meta.title = sanitizeName(params.title);
  meta.sourceUrl = params.sourceUrl;
  meta.durationSec = params.durationSec;
  meta.notesFailed = Boolean(params.notesFailed);
  fs.writeFileSync(metaPath(dir), JSON.stringify(meta, null, 2), 'utf-8');
  fs.writeFileSync(notesPath(dir), params.markdown, 'utf-8');
  if (params.raw) fs.writeFileSync(rawPath(dir), JSON.stringify(params.raw), 'utf-8');
  return { folderName, subject, ...meta };
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
      assignments: [
        ...(previousRaw.assignments ?? []),
        ...(additionalRaw.assignments ?? []).map((a) => ({ ...a, offsetSec: a.offsetSec + previousDurationSec })),
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

// Photos attached after the fact - e.g. slides shot on a phone during a
// mic-only recording that never went through the live slide pipeline.
// Filenames are timestamp-prefixed so a plain sort is also chronological.
function photosDir(libraryPath: string, subject: string, folderName: string): string {
  return path.join(libraryPath, subject, folderName, 'photos');
}

export function listLecturePhotos(libraryPath: string, subject: string, folderName: string): string[] {
  try {
    return fs.readdirSync(photosDir(libraryPath, subject, folderName)).sort();
  } catch {
    return [];
  }
}

export function addLecturePhoto(libraryPath: string, subject: string, folderName: string, base64Data: string, ext: string): string {
  const dir = photosDir(libraryPath, subject, folderName);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
  fs.writeFileSync(path.join(dir, fileName), Buffer.from(base64Data, 'base64'));
  return fileName;
}

export function deleteLecturePhoto(libraryPath: string, subject: string, folderName: string, fileName: string): void {
  fs.rmSync(path.join(photosDir(libraryPath, subject, folderName), fileName), { force: true });
}

export function loadLecturePhoto(libraryPath: string, subject: string, folderName: string, fileName: string): Buffer {
  return fs.readFileSync(path.join(photosDir(libraryPath, subject, folderName), fileName));
}
