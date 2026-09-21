import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

// Port the local WebSocket server listens on. The browser extension connects here.
// Must match WS_PORT in extension/background.js.
export const WS_PORT = 8787;

export const DEFAULT_SUBJECT = 'Без предмета';

function defaultLibraryPath(): string {
  return path.join(app.getPath('documents'), 'AI Lecture Notes');
}

export interface AppSettings {
  // How often (seconds) the extension is asked to capture a slide screenshot.
  slideIntervalSec: number;
  // Global hotkey that toggles the main window.
  toggleHotkey: string;
  // Folder on disk where subject/lecture notes are stored. User-configurable
  // so notes can live in e.g. a synced OneDrive folder instead of AppData.
  libraryPath: string;
  // Subject picked in the Live tab, remembered between lectures.
  lastSubject: string;
  // Name/nickname to listen for in the live transcript - a desktop
  // notification fires when the teacher says it, in case the student didn't
  // hear being called on. Empty disables the feature.
  callOutName: string;
  // A phrase the student says out loud during the lecture (e.g. "отметь
  // это") to flag the current moment as important - picked up in the live
  // transcript and called out in the final conspect. Empty disables it.
  markerPhrase: string;
  // 'concise' (default) asks for a condensed bullet summary; 'detailed' asks
  // for a thorough, long-form writeup that keeps explanations and examples
  // instead of compressing everything to bullets - for whoever wants a
  // conspect closer to a full document than a cheat sheet.
  notesDetailLevel: 'concise' | 'detailed';
}

function defaultSettings(): AppSettings {
  return {
    slideIntervalSec: 25,
    toggleHotkey: 'CommandOrControl+Shift+L',
    libraryPath: defaultLibraryPath(),
    lastSubject: DEFAULT_SUBJECT,
    callOutName: '',
    markerPhrase: '',
    notesDetailLevel: 'concise',
  };
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): AppSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: AppSettings): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
}
