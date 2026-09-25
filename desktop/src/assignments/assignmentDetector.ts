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
  // Word roots covering every common inflection/colloquial form - "домашнюю
  // вам задам", "домашка", "домашки" etc. all matched a real lecture where
  // the fixed phrase "домашнее задание" below did not, since ASR output and
  // natural speech rarely land on that exact two-word order.
  'домашн',
  'домашк',
  // Homework / for-later phrasing.
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
  // In-class, right-now task phrasing - previously missed entirely, since
  // every phrase above assumes the task is for later, not for this session.
  'решите сейчас',
  'попробуйте решить',
  'попробуйте самостоятельно',
  'попробуйте сами',
  'давайте решим',
  'давайте порешаем',
  'разберём задачу',
  'разберите задачу',
  'запишите задачу',
  'запишите условие',
  'откройте тетрад',
  'возьмите листочек',
  'возьмите листок',
  'приступайте к решению',
  'приступаем к решению',
  'начинайте решать',
  'вот задача',
  'перед вами задача',
  'следующая задача',
  'даю вам ',
  'на решение ',
];

export function detectAssignmentPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return ASSIGNMENT_PHRASES.some((phrase) => lower.includes(phrase));
}
