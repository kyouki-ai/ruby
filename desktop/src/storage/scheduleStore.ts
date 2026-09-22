import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

// A user's whole class timetable, kept separate from any one subject since
// one entry ("Матан, ауд. 305, Пн 9:00") isn't really "inside" a subject
// folder the way a lecture recording is - it's schedule metadata that can
// exist before a single lecture has ever been recorded for it.
export interface ScheduleEntry {
  id: string;
  title: string;
  // Optional link to an existing subject folder, purely for the user's own
  // reference - nothing here reads/writes into that subject's data.
  subject?: string;
  type: 'weekly' | 'once';
  // 0 = Monday .. 6 = Sunday, only set for type 'weekly'.
  dayOfWeek?: number;
  // ISO date (yyyy-mm-dd), only set for type 'once'.
  date?: string;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  location?: string;
  teacher?: string;
  // Minutes before startTime to fire a notification; 0 = right at start time.
  notifyMinutesBefore: number;
}

function schedulePath(libraryPath: string): string {
  return path.join(libraryPath, 'schedule.json');
}

export function listSchedule(libraryPath: string): ScheduleEntry[] {
  try {
    const raw = fs.readFileSync(schedulePath(libraryPath), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(libraryPath: string, entries: ScheduleEntry[]): void {
  fs.mkdirSync(libraryPath, { recursive: true });
  fs.writeFileSync(schedulePath(libraryPath), JSON.stringify(entries, null, 2), 'utf-8');
}

/** Creates a new entry, or overwrites an existing one when `entry.id` is given. */
export function saveScheduleEntry(libraryPath: string, entry: Omit<ScheduleEntry, 'id'> & { id?: string }): ScheduleEntry {
  const entries = listSchedule(libraryPath);
  const saved: ScheduleEntry = { ...entry, id: entry.id || randomUUID() };
  const idx = entries.findIndex((e) => e.id === saved.id);
  if (idx >= 0) entries[idx] = saved;
  else entries.push(saved);
  saveAll(libraryPath, entries);
  return saved;
}

export function deleteScheduleEntry(libraryPath: string, id: string): void {
  saveAll(libraryPath, listSchedule(libraryPath).filter((e) => e.id !== id));
}
