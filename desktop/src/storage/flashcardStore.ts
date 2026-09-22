import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { listSubjects, listLectures } from './libraryStore';

/**
 * Flashcards generated from a lecture's notes, with lightweight SM-2-style
 * spaced repetition - one JSON file per lecture, alongside its notes.md/
 * raw.json, so it travels with the lecture like everything else.
 */
export interface Flashcard {
  id: string;
  front: string;
  back: string;
  interval: number; // days until the next review
  ease: number; // ease factor, SM-2 style, starts at 2.5
  reps: number; // consecutive successful (non-"again") reviews
  dueAt: string; // ISO timestamp - due for review once now >= this
}

function flashcardsPath(libraryPath: string, subject: string, folderName: string): string {
  return path.join(libraryPath, subject, folderName, 'flashcards.json');
}

export function loadFlashcards(libraryPath: string, subject: string, folderName: string): Flashcard[] {
  try {
    const raw = fs.readFileSync(flashcardsPath(libraryPath, subject, folderName), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export function saveFlashcards(libraryPath: string, subject: string, folderName: string, cards: Flashcard[]): void {
  fs.writeFileSync(flashcardsPath(libraryPath, subject, folderName), JSON.stringify(cards, null, 2), 'utf-8');
}

/** Wraps freshly AI-generated front/back pairs into due-immediately cards. */
export function createCardsFromPairs(pairs: { front: string; back: string }[]): Flashcard[] {
  const now = new Date().toISOString();
  return pairs.map((p) => ({
    id: crypto.randomUUID(),
    front: p.front,
    back: p.back,
    interval: 0,
    ease: 2.5,
    reps: 0,
    dueAt: now,
  }));
}

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/**
 * SM-2-lite: "again" drops the card back to square one (shown again in this
 * same session); the other three ratings grow the interval, with the ease
 * factor nudged the classic SM-2 way so consistently-easy cards space out
 * faster and consistently-hard ones stay frequent.
 */
export function reviewCard(card: Flashcard, rating: ReviewRating): Flashcard {
  let { interval, ease, reps } = card;

  if (rating === 'again') {
    reps = 0;
    interval = 0;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    const easeDelta = { hard: -0.15, good: 0, easy: 0.15 }[rating];
    ease = Math.max(1.3, ease + easeDelta);
    reps += 1;
    if (reps === 1) interval = rating === 'hard' ? 1 : rating === 'easy' ? 4 : 1;
    else if (reps === 2) interval = rating === 'hard' ? 2 : rating === 'easy' ? 8 : 6;
    else interval = Math.round(interval * ease);
  }

  const dueAt = new Date(Date.now() + interval * 24 * 60 * 60 * 1000).toISOString();
  return { ...card, interval, ease, reps, dueAt };
}

export interface DueDeckSummary {
  subject: string;
  folderName: string;
  lectureTitle: string;
  dueCount: number;
}

/** Scans the whole library for lectures with at least one card due now - powers a global "review" entry point instead of hunting lecture by lecture. */
export function listDueFlashcards(libraryPath: string): DueDeckSummary[] {
  const now = Date.now();
  const summaries: DueDeckSummary[] = [];

  for (const subject of listSubjects(libraryPath)) {
    for (const lecture of listLectures(libraryPath, subject)) {
      const cards = loadFlashcards(libraryPath, subject, lecture.folderName);
      const dueCount = cards.filter((c) => new Date(c.dueAt).getTime() <= now).length;
      if (dueCount > 0) {
        summaries.push({ subject, folderName: lecture.folderName, lectureTitle: lecture.title, dueCount });
      }
    }
  }

  return summaries;
}

// A simple "days in a row reviewed at least one card" counter - one file per
// library, not per lecture, since the streak is about the study habit as a
// whole rather than any single deck.
export interface StudyStreak {
  lastReviewDate: string; // yyyy-mm-dd, local date of the last counted review
  currentStreak: number;
  longestStreak: number;
}

function streakPath(libraryPath: string): string {
  return path.join(libraryPath, 'study-streak.json');
}

export function loadStudyStreak(libraryPath: string): StudyStreak {
  try {
    return JSON.parse(fs.readFileSync(streakPath(libraryPath), 'utf-8'));
  } catch {
    return { lastReviewDate: '', currentStreak: 0, longestStreak: 0 };
  }
}

/** Call once per review - a no-op if today was already counted, so reviewing 20 cards in a row only bumps the streak once. */
export function bumpStudyStreak(libraryPath: string): StudyStreak {
  const todayKey = new Date().toISOString().slice(0, 10);
  const streak = loadStudyStreak(libraryPath);
  if (streak.lastReviewDate === todayKey) return streak;

  const yesterdayKey = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const currentStreak = streak.lastReviewDate === yesterdayKey ? streak.currentStreak + 1 : 1;
  const updated: StudyStreak = {
    lastReviewDate: todayKey,
    currentStreak,
    longestStreak: Math.max(streak.longestStreak, currentStreak),
  };
  fs.writeFileSync(streakPath(libraryPath), JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}
