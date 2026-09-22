/**
 * Detects a lecturer announcing a task/homework out loud, so it can be
 * flagged live (PC notification) and saved for later instead of getting
 * buried in the transcript. Plain keyword matching, not an extra LLM call
 * per segment - the free-tier Gemini quota is already tight (see
 * geminiClient.ts), and this only needs to catch common phrasings, not
 * understand arbitrary language.
 */
export interface AssignmentEntry {
  offsetSec: number;
  text: string;
  slideText: string | null;
  slideScreenshotBase64: string | null;
  detectedAt: string;
}

const ASSIGNMENT_PHRASES = [
  'домашнее задание',
  'дз будет',
  'дз на',
  'дз к',
  'запишите задание',
  'запишите дз',
  'задание на дом',
  'задание к следующ',
  'к следующему занятию',
  'к следующей паре',
  'к следующей лекции',
  'к следующему семинару',
  'на следующее занятие',
  'на следующей паре',
  'на семинаре сделайте',
  'на практике сделайте',
  'дома сделайте',
  'дома решите',
  'дома прочитайте',
  'решите задачу',
  'решите задачи',
  'выполните задание',
  'выполнить задание',
  'практическое задание',
  'самостоятельная работа',
  'нужно будет сдать',
  'сдать до',
  'подготовьте к',
  'принесите на следующ',
];

export function detectAssignmentPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return ASSIGNMENT_PHRASES.some((phrase) => lower.includes(phrase));
}
