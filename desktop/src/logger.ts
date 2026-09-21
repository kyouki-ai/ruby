import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

function logPath(): string {
  return path.join(app.getPath('userData'), 'error.log');
}

/** Appends a timestamped line to userData/error.log - the only place Gemini/pipeline failures are visible in a packaged app. */
export function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  const line = `[${new Date().toISOString()}] ${context}: ${message}\n`;
  console.error(line);
  try {
    fs.appendFileSync(logPath(), line);
  } catch {
    // Nothing more useful to do if even logging fails.
  }
}
