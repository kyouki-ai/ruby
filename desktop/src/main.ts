import * as dotenv from 'dotenv';
dotenv.config();

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  clipboard,
  nativeImage,
  dialog,
  shell,
  Notification,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// Only one copy of this app may run at a time - a second launch would try to
// bind the same WebSocket port and crash with EADDRINUSE, leaving a stray
// tray icon behind. If another instance already holds the lock, hand off to
// it (focus its window) and exit immediately instead of starting up.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

// Belt-and-suspenders for the in-app mic recorder: an AudioContext created a
// couple of awaits after the button click (once getUserMedia resolves) can
// otherwise start 'suspended' under Chromium's autoplay policy.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

import { WsServer, LectureSession } from './server/wsServer';
import { AudioPipeline, TranscriptSegment } from './transcription/audioPipeline';
import { SlidePipeline, SlideEntry, describePhoto } from './slides/slidePipeline';
import {
  buildLectureNotes,
  generateQuizFromNotes,
  generateFlashcardPairsFromNotes,
  MarkedMoment,
  NotesDetailLevel,
} from './gemini/notesBuilder';
import * as flashcards from './storage/flashcardStore';
import { detectAssignmentPhrase, AssignmentEntry } from './assignments/assignmentDetector';
import { setApiKeys, isApiKeyConfigured } from './gemini/geminiClient';
import { streamChatReply } from './ai/chatReply';
import { setGroqApiKey, isGroqConfigured } from './groq/groqClient';
import { saveApiKey, loadApiKeys, clearApiKey, saveGroqApiKey, loadGroqApiKey, clearGroqApiKey } from './secrets';
import * as library from './storage/libraryStore';
import * as chatStore from './storage/chatStore';
import * as schedule from './storage/scheduleStore';
import { startScheduleNotifier } from './schedule/scheduleNotifier';
import { loadSettings, saveSettings, AppSettings } from './config';
import * as channels from './ipc/channels';
import { logError } from './logger';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: AppSettings = loadSettings();

// A second launch attempt lands here instead of starting a new app - just
// bring the already-running window to the front.
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// Per-lecture state. Reset on every new "hello" handshake from the extension.
let currentSession: LectureSession | null = null;
let transcript: TranscriptSegment[] = [];
let slidePipeline: SlidePipeline = new SlidePipeline();
let audioPipeline: AudioPipeline | null = null;
let markedMoments: MarkedMoment[] = [];
let assignments: AssignmentEntry[] = [];
// The most recent slide seen, for pairing a detected assignment with the
// slide that was likely on screen when it was announced - not persisted on
// its own, just used as context at the moment of detection.
let lastSlideText: string | null = null;
let lastSlideScreenshotBase64: string | null = null;
// If set, the next "stop" appends to this existing lecture instead of
// creating a new one - picked via the "Лекция" dropdown on the Live tab.
let targetLectureFolder: string | null = null;
// Lets the renderer's "Stop" button interrupt an in-flight chat reply.
let currentChatAbortController: AbortController | null = null;

/**
 * Path to the browser extension folder, so the "open extension folder"
 * button works both in dev (`npm start`, running from source) and in the
 * packaged .exe (where it's copied into resources/extension - see
 * package.json's build.extraResources).
 */
function mimeTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function getExtensionPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(__dirname, '..', '..', 'extension');
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    // Set directly rather than relying on the packaged .exe's embedded icon
    // (that embedding step - rcedit - is skipped via signAndEditExecutable:
    // false in package.json, to work around a Windows/electron-builder
    // codesign-tool download issue), so the title bar/taskbar icon is
    // always correct regardless of how the app was built or launched.
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // No native title bar - the app's own topbar already shows the icon and
    // "AI Lecture Notes" name, so a second, identical OS title bar right
    // above it was pure duplication. Minimize/maximize/close move into the
    // renderer as regular buttons (see index.html's window-controls).
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron's default sandboxed preload can only `require` a handful of
      // built-ins, not our own compiled ./ipc/channels module. contextIsolation
      // (the setting that actually matters - it keeps the renderer's page
      // script out of preload's/Node's world) stays on either way.
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Allow the renderer's own getUserMedia(audio) call for the in-app
  // microphone recorder (offline lectures, no browser extension needed).
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  // Links like the "get an API key" one should open in the user's real
  // browser, not spawn another Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Hide instead of quitting so the tray icon + global hotkey keep working.
  mainWindow.on('close', (event) => {
    if (!(app as any).isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Ctrl+F find bar (renderer.js) - relays Chromium's own in-page search
  // results back, since the renderer can't call webContents methods itself.
  mainWindow.webContents.on('found-in-page', (_e, result) => {
    sendToRenderer(channels.IPC_FOUND_IN_PAGE, {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });
}

function toggleWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Ruby');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { label: 'Quit', click: () => { (app as any).isQuitting = true; app.quit(); } },
    ])
  );
  tray.on('click', toggleWindow);
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  mainWindow?.webContents.send(channel, ...args);
}

/** Whole-word, Unicode-aware match - a plain substring check would also fire on e.g. "Никитин" for "Никита". */
function containsWholeWord(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

// Throttled separately from the transcript itself - the teacher may repeat a
// name across several chunks in a row, and that should still be one nudge,
// not one notification per chunk.
let lastCallOutNotifiedAt = 0;
const CALL_OUT_THROTTLE_MS = 45_000;

function checkCallOut(segmentText: string): void {
  const name = settings.callOutName.trim();
  if (!name || !Notification.isSupported()) return;
  if (!containsWholeWord(segmentText, name)) return;
  if (Date.now() - lastCallOutNotifiedAt < CALL_OUT_THROTTLE_MS) return;
  lastCallOutNotifiedAt = Date.now();

  const notification = new Notification({
    title: 'Тебя зовут на лекции',
    body: `Прозвучало «${name}»: ${segmentText.trim()}`,
  });
  notification.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  notification.show();
}

/** Checks a transcribed segment for the marker phrase and records it if found - returns whether it matched, so the live transcript can highlight that line too. */
function checkMarker(segment: TranscriptSegment): boolean {
  const phrase = settings.markerPhrase.trim();
  if (!phrase || !containsWholeWord(segment.text, phrase)) return false;
  markedMoments.push({ offsetSec: segment.startSec, text: segment.text });
  return true;
}

// A teacher tends to repeat/rephrase an assignment across a couple of
// transcript chunks in a row - throttled so that reads as one detection,
// not several near-duplicate notifications and list entries.
let lastAssignmentNotifiedAt = 0;
const ASSIGNMENT_THROTTLE_MS = 20_000;

/** Checks a transcribed segment for an assignment/homework announcement, records it (with whatever slide was last seen) and notifies. */
function checkAssignment(segment: TranscriptSegment): void {
  if (!detectAssignmentPhrase(segment.text)) return;
  if (Date.now() - lastAssignmentNotifiedAt < ASSIGNMENT_THROTTLE_MS) return;
  lastAssignmentNotifiedAt = Date.now();

  const entry: AssignmentEntry = {
    offsetSec: segment.startSec,
    text: segment.text,
    slideText: lastSlideText,
    slideScreenshotBase64: lastSlideScreenshotBase64,
    detectedAt: new Date().toISOString(),
  };
  assignments.push(entry);
  sendToRenderer(channels.IPC_ASSIGNMENT_DETECTED, entry);

  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'Похоже, прозвучало задание',
      body: segment.text.trim(),
    });
    notification.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
    });
    notification.show();
  }
}

/**
 * The structured conspect (headings/bullets, via Gemini) is only built once,
 * when the lecture stops - not continuously during recording. Rebuilding it
 * every time a segment/slide came in used to cost one extra Gemini call
 * every few minutes, all day, for a "live" view of something that's only
 * actually needed once the lecture is over. The live transcript itself still
 * updates in real time below, for free - it's just the raw segments already
 * coming back from transcription, no extra API calls involved.
 */
function resetLectureState(): void {
  currentSession = null;
  transcript = [];
  markedMoments = [];
  assignments = [];
  lastSlideText = null;
  lastSlideScreenshotBase64 = null;
  slidePipeline = new SlidePipeline();
  audioPipeline = new AudioPipeline({
    onSegment: (segment) => {
      transcript.push(segment);
      const marked = checkMarker(segment);
      sendToRenderer(channels.IPC_TRANSCRIPT_SEGMENT, { ...segment, marked });
      checkCallOut(segment.text);
      checkAssignment(segment);
    },
    onError: (err) => logError('Gemini transcription error', err),
  });
}

/** Starts a fresh lecture session - used by both the extension (over WS) and the in-app mic recorder. */
function startNewSession(tabTitle: string, tabUrl: string): void {
  resetLectureState();
  currentSession = { tabTitle, tabUrl, startedAt: Date.now() };
  sendToRenderer(channels.IPC_CONNECTION_STATUS, true, tabTitle);
  startSilenceMonitor();
}

// Auto-stop-on-silence (opt-in, see AppSettings.autoStopSilenceEnabled):
// fires only after a MUCH longer silence than any normal between-pairs
// break (typically 10-20 min at a Russian university) would ever produce,
// and warns the renderer well before the actual stop so the user can just
// keep talking - or explicitly dismiss it - to cancel it. Never stops
// anything itself; it only ever asks the renderer to, since the renderer
// is what already knows whether this is a mic or browser-extension session.
const SILENCE_CHECK_INTERVAL_MS = 30_000;
const SILENCE_WARN_MS = 20 * 60_000;
const SILENCE_AUTOSTOP_MS = 25 * 60_000;

let silenceCheckTimer: ReturnType<typeof setInterval> | null = null;
let silenceWarningActive = false;

function startSilenceMonitor(): void {
  stopSilenceMonitor();
  if (!settings.autoStopSilenceEnabled) return;
  silenceCheckTimer = setInterval(checkSilence, SILENCE_CHECK_INTERVAL_MS);
}

function stopSilenceMonitor(): void {
  if (silenceCheckTimer) {
    clearInterval(silenceCheckTimer);
    silenceCheckTimer = null;
  }
  silenceWarningActive = false;
}

function checkSilence(): void {
  if (!audioPipeline || !currentSession) return;
  const silentMs = audioPipeline.getSilenceDurationMs();

  if (silentMs >= SILENCE_AUTOSTOP_MS) {
    sendToRenderer(channels.IPC_SILENCE_WARNING, { silentForSec: Math.floor(silentMs / 1000), autoStopInSec: 0 });
    stopSilenceMonitor();
    return;
  }
  if (silentMs >= SILENCE_WARN_MS) {
    silenceWarningActive = true;
    sendToRenderer(channels.IPC_SILENCE_WARNING, {
      silentForSec: Math.floor(silentMs / 1000),
      autoStopInSec: Math.max(0, Math.ceil((SILENCE_AUTOSTOP_MS - silentMs) / 1000)),
    });
  } else if (silenceWarningActive) {
    silenceWarningActive = false;
    sendToRenderer(channels.IPC_SILENCE_WARNING_CLEARED);
  }
}

let wsServer: WsServer | null = null;

function setupWsServer(): void {
  resetLectureState();

  wsServer = new WsServer({
    onConnected: (session) => {
      // The extension reconnects (and resends "hello") after any network
      // blip while a recording is still going - that must NOT wipe the
      // transcript/slides gathered so far. Only a genuinely new recording
      // (no session already in progress) resets state.
      if (currentSession) {
        sendToRenderer(channels.IPC_CONNECTION_STATUS, true, currentSession.tabTitle);
        return;
      }
      startNewSession(session.tabTitle, session.tabUrl);
    },
    onDisconnected: () => {
      sendToRenderer(channels.IPC_CONNECTION_STATUS, false);
    },
    onExtensionReady: (ready) => {
      sendToRenderer(channels.IPC_EXTENSION_READY, ready);
    },
    onAudioChunk: (msg) => {
      audioPipeline?.enqueueChunk(msg.pcmBase64, msg.startOffsetSec, msg.durationSec);
    },
    onSlide: (msg) => {
      // Tracked regardless of dedup, so an assignment detected moments later
      // can be paired with whatever was actually on screen at the time.
      lastSlideText = msg.text || null;
      lastSlideScreenshotBase64 = msg.screenshotBase64 || null;

      // Shown live regardless of dedup, purely so the user can see the
      // capture loop is actually alive - costs nothing, it's the same
      // screenshot already received, not a new Gemini call.
      sendToRenderer(channels.IPC_SLIDE_PREVIEW, {
        screenshotBase64: msg.screenshotBase64,
        offsetSec: msg.offsetSec,
      });

      void slidePipeline
        .ingest({ offsetSec: msg.offsetSec, text: msg.text, screenshotBase64: msg.screenshotBase64 })
        .then((entry: SlideEntry | null) => {
          if (entry) {
            sendToRenderer(channels.IPC_SLIDE_ADDED, entry);
          }
        })
        .catch((err) => logError('Slide processing error', err));
    },
    onStop: () => {
      void finalizeSession();
    },
  });

  wsServer.start();
}

async function finalizeSession(): Promise<void> {
  if (!currentSession) return;
  stopSilenceMonitor();
  const durationSec = (Date.now() - currentSession.startedAt) / 1000;

  // Enqueuing a chunk only schedules its Gemini transcription - it doesn't
  // wait for it. Without this, "stop" right after speaking would build notes
  // before the last (or, for a short recording, the only) chunk came back.
  await audioPipeline?.waitForIdle();

  let markdown: string;
  let notesFailed = false;
  try {
    markdown = await buildLectureNotes(transcript, slidePipeline.slides, markedMoments);
  } catch (err) {
    logError('Failed to build notes via Gemini - saving raw transcript instead', err);
    // Never lose the recording just because the notes-building call failed
    // (rate limit, timeout, network) - fall back to the raw material. The
    // real transcript/slides are still saved separately (see `raw` below),
    // so a rebuild can be retried later instead of this being the final word.
    notesFailed = true;
    markdown =
      transcript.length > 0
        ? '## Расшифровка (сборка конспекта не удалась)\n\n' + transcript.map((s) => s.text).join(' ')
        : '*Запись не удалось расшифровать - конспект пуст. Подробности в error.log.*';
  }
  sendToRenderer(channels.IPC_NOTES_UPDATED, markdown);

  const raw = { transcript, slides: slidePipeline.slides, assignments };

  try {
    const meta = targetLectureFolder
      ? library.appendToLecture(
          settings.libraryPath,
          settings.lastSubject,
          targetLectureFolder,
          markdown,
          durationSec,
          currentSession.tabTitle || 'Lecture',
          notesFailed,
          raw
        )
      : library.saveLecture(settings.libraryPath, settings.lastSubject, {
          title: currentSession.tabTitle || 'Lecture',
          sourceUrl: currentSession.tabUrl,
          durationSec,
          markdown,
          notesFailed,
          raw,
        });
    console.log(`Lecture saved: ${settings.lastSubject}/${meta.folderName}`);
    sendToRenderer(channels.IPC_LECTURE_SAVED, meta);
  } catch (err) {
    logError('Failed to save lecture to disk', err);
  }
}

function setupIpcHandlers(): void {
  ipcMain.handle(channels.IPC_GET_SETTINGS, () => settings);
  ipcMain.handle(channels.IPC_SAVE_SETTINGS, (_e, next: AppSettings) => {
    settings = next;
    saveSettings(settings);
  });
  ipcMain.handle(channels.IPC_COPY_NOTES, (_e, markdown: string) => {
    clipboard.writeText(markdown);
  });
  ipcMain.handle(channels.IPC_COPY_TEXT, (_e, text: string) => {
    clipboard.writeText(text);
  });
  // Copies both the prompt text and the slide image (when there is one) in
  // one go, so pasting into another AI's chat drops in whichever of the two
  // it accepts - most take an image paste directly.
  ipcMain.handle(channels.IPC_COPY_ASSIGNMENT_PROMPT, (_e, promptText: string, screenshotBase64: string | null) => {
    if (screenshotBase64) {
      const image = nativeImage.createFromDataURL(`data:image/jpeg;base64,${screenshotBase64}`);
      clipboard.write({ text: promptText, image });
    } else {
      clipboard.writeText(promptText);
    }
  });
  ipcMain.handle(channels.IPC_OPEN_EXTENSION_FOLDER, () => {
    shell.openPath(getExtensionPath());
  });

  ipcMain.handle(channels.IPC_WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.handle(channels.IPC_WINDOW_MAXIMIZE_TOGGLE, () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle(channels.IPC_WINDOW_CLOSE, () => mainWindow?.close());

  // In-app microphone recording - no browser/extension involved at all.
  ipcMain.handle(channels.IPC_START_MIC_SESSION, () => {
    startNewSession('Микрофон (офлайн-лекция)', '');
  });
  ipcMain.handle(
    channels.IPC_MIC_AUDIO_CHUNK,
    (_e, pcmBase64: string, startOffsetSec: number, durationSec: number) => {
      audioPipeline?.enqueueChunk(pcmBase64, startOffsetSec, durationSec);
    }
  );
  ipcMain.handle(channels.IPC_STOP_MIC_SESSION, async () => {
    await finalizeSession();
    sendToRenderer(channels.IPC_CONNECTION_STATUS, false);
  });
  ipcMain.handle(channels.IPC_DISMISS_SILENCE_WARNING, () => {
    audioPipeline?.resetSilenceTimer();
    silenceWarningActive = false;
  });

  // Attach an existing slide deck file instead of live-capturing slides.
  ipcMain.handle(channels.IPC_ATTACH_SLIDE_FILE, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Слайды', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;

    const filePath = result.filePaths[0];
    const base64Data = fs.readFileSync(filePath).toString('base64');
    const mimeType = mimeTypeForFile(filePath);
    const offsetSec = currentSession ? (Date.now() - currentSession.startedAt) / 1000 : 0;

    const entry = await slidePipeline.ingestFile(offsetSec, base64Data, mimeType);
    sendToRenderer(channels.IPC_SLIDE_ADDED, entry);

    // A manually attached file is a deliberate one-off action, unlike the
    // steady trickle of live slide captures - rebuild immediately instead of
    // waiting for the usual debounce.
    try {
      const markdown = await buildLectureNotes(transcript, slidePipeline.slides, markedMoments);
      sendToRenderer(channels.IPC_NOTES_UPDATED, markdown);
    } catch (err) {
      logError('Failed to rebuild notes after attaching file', err);
    }

    return entry;
  });

  ipcMain.handle(channels.IPC_GET_EXTENSION_READY, () => wsServer?.isExtensionReady() ?? false);
  ipcMain.handle(channels.IPC_REMOTE_START_RECORDING, (_e, mode: 'tab-slides' | 'tab-audio-only') =>
    wsServer?.sendRemoteStart(mode) ?? false
  );
  ipcMain.handle(channels.IPC_REMOTE_STOP_RECORDING, () => wsServer?.sendRemoteStop() ?? false);

  ipcMain.handle(
    channels.IPC_CHAT_SEND,
    async (
      _e,
      threadId: string,
      history: { role: 'user' | 'model'; text: string }[],
      message: string
    ) => {
      const thread = chatStore.loadChatThread(threadId);
      if (!thread) throw new Error('Чат не найден - возможно, он был удалён.');
      const isGlobal = !thread.subject;
      const context = isGlobal
        ? library.buildFullLibraryContext(settings.libraryPath)
        : library.buildChatContext(settings.libraryPath, thread.subject!, thread.folderName ?? undefined);
      currentChatAbortController = new AbortController();
      try {
        const reply = await streamChatReply(
          context,
          history,
          message,
          isGlobal,
          (delta) => sendToRenderer(channels.IPC_CHAT_STREAM_DELTA, delta),
          currentChatAbortController.signal
        );
        chatStore.saveChatMessages(threadId, [
          ...history,
          { role: 'user', text: message },
          { role: 'model', text: reply },
        ]);
        return reply;
      } catch (err) {
        logError('Chat request failed', err);
        throw err;
      } finally {
        currentChatAbortController = null;
      }
    }
  );
  // Interrupts whichever chat-send call is currently in flight (see above) -
  // only one can run at a time (the UI disables Send while streaming), so a
  // single shared controller is enough.
  ipcMain.handle(channels.IPC_CHAT_STOP, () => {
    currentChatAbortController?.abort();
  });

  // Named, persisted chat threads - see storage/chatStore.ts.
  ipcMain.handle(channels.IPC_LIST_CHAT_THREADS, () => chatStore.listChatThreads());
  ipcMain.handle(channels.IPC_CREATE_CHAT_THREAD, (_e, title: string) => chatStore.createChatThread(title));
  ipcMain.handle(channels.IPC_LOAD_CHAT_THREAD, (_e, id: string) => chatStore.loadChatThread(id));
  ipcMain.handle(channels.IPC_RENAME_CHAT_THREAD, (_e, id: string, title: string) =>
    chatStore.renameChatThread(id, title)
  );
  ipcMain.handle(channels.IPC_DELETE_CHAT_THREAD, (_e, id: string) => chatStore.deleteChatThread(id));
  ipcMain.handle(
    channels.IPC_FIND_OR_CREATE_LECTURE_THREAD,
    (_e, subject: string, folderName: string | null, title: string) =>
      chatStore.findOrCreateLectureThread(subject, folderName, title)
  );

  // API key - each user pastes in their own free Gemini key here.
  ipcMain.handle(channels.IPC_GET_API_STATUS, () => ({ configured: isApiKeyConfigured() }));
  ipcMain.handle(channels.IPC_SAVE_API_KEY, (_e, key: string) => {
    saveApiKey(key);
    setApiKeys(loadApiKeys());
    return { configured: isApiKeyConfigured() };
  });
  ipcMain.handle(channels.IPC_CLEAR_API_KEY, () => {
    clearApiKey();
    setApiKeys([]);
    return { configured: isApiKeyConfigured() };
  });

  // Groq key - optional, only for transcription (see groqClient.ts).
  ipcMain.handle(channels.IPC_GET_GROQ_API_STATUS, () => ({ configured: isGroqConfigured() }));
  ipcMain.handle(channels.IPC_SAVE_GROQ_API_KEY, (_e, key: string) => {
    saveGroqApiKey(key);
    setGroqApiKey(loadGroqApiKey());
    return { configured: isGroqConfigured() };
  });
  ipcMain.handle(channels.IPC_CLEAR_GROQ_API_KEY, () => {
    clearGroqApiKey();
    setGroqApiKey(null);
    return { configured: isGroqConfigured() };
  });

  // Library: subjects and lectures, stored as plain folders on disk.
  ipcMain.handle(channels.IPC_LIST_SUBJECTS, () => library.listSubjects(settings.libraryPath));
  ipcMain.handle(channels.IPC_CREATE_SUBJECT, (_e, name: string) => library.createSubject(settings.libraryPath, name));
  ipcMain.handle(channels.IPC_RENAME_SUBJECT, (_e, oldName: string, newName: string) =>
    library.renameSubject(settings.libraryPath, oldName, newName)
  );
  ipcMain.handle(channels.IPC_DELETE_SUBJECT, (_e, name: string) => library.deleteSubject(settings.libraryPath, name));

  ipcMain.handle(channels.IPC_LIST_LECTURES, (_e, subject: string) => library.listLectures(settings.libraryPath, subject));
  ipcMain.handle(channels.IPC_LOAD_LECTURE, (_e, subject: string, folderName: string) =>
    library.loadLectureMarkdown(settings.libraryPath, subject, folderName)
  );
  ipcMain.handle(channels.IPC_LOAD_LECTURE_RAW, (_e, subject: string, folderName: string) =>
    library.loadLectureRaw(settings.libraryPath, subject, folderName)
  );
  // (Re)builds the conspect from a saved lecture's original transcript/slides
  // - available any time after saving too, not just once at record-stop, so
  // a failed build (rate limit, timeout) or an unhappy result can be retried.
  ipcMain.handle(
    channels.IPC_REBUILD_LECTURE_NOTES,
    async (_e, subject: string, folderName: string, detailLevel?: NotesDetailLevel) => {
      const raw = library.loadLectureRaw(settings.libraryPath, subject, folderName);
      if (!raw) throw new Error('Для этой лекции не сохранена исходная запись - пересборка недоступна.');
      const markdown = await buildLectureNotes(raw.transcript, raw.slides, [], detailLevel);
      library.saveLectureMarkdown(settings.libraryPath, subject, folderName, markdown, false);
      return markdown;
    }
  );
  ipcMain.handle(channels.IPC_CREATE_LECTURE, (_e, subject: string, title: string, groupId?: string) =>
    library.saveLecture(settings.libraryPath, subject, { title, sourceUrl: '', durationSec: 0, markdown: '', groupId })
  );
  ipcMain.handle(channels.IPC_GET_SUBJECT_META, (_e, subject: string) =>
    library.loadSubjectMeta(settings.libraryPath, subject)
  );
  ipcMain.handle(channels.IPC_CREATE_LECTURE_GROUP, (_e, subject: string, name: string) =>
    library.createLectureGroup(settings.libraryPath, subject, name)
  );
  ipcMain.handle(channels.IPC_RENAME_LECTURE_GROUP, (_e, subject: string, groupId: string, newName: string) =>
    library.renameLectureGroup(settings.libraryPath, subject, groupId, newName)
  );
  ipcMain.handle(channels.IPC_DELETE_LECTURE_GROUP, (_e, subject: string, groupId: string) =>
    library.deleteLectureGroup(settings.libraryPath, subject, groupId)
  );
  ipcMain.handle(channels.IPC_REORDER_LECTURE_GROUPS, (_e, subject: string, orderedGroupIds: string[]) =>
    library.reorderLectureGroups(settings.libraryPath, subject, orderedGroupIds)
  );
  ipcMain.handle(
    channels.IPC_SET_LECTURE_POSITION,
    (_e, subject: string, folderName: string, groupId: string | null, order: number) =>
      library.setLecturePosition(settings.libraryPath, subject, folderName, groupId, order)
  );

  ipcMain.handle(channels.IPC_LIST_LECTURE_PHOTOS, (_e, subject: string, folderName: string) =>
    library.listLecturePhotos(settings.libraryPath, subject, folderName)
  );
  // Attaching a photo also feeds it into the conspect, same as attaching a
  // slide file live during recording (IPC_ATTACH_SLIDE_FILE) - the whole
  // point is covering slides shot on a phone during a mic-only recording,
  // so the AI needs to actually see them, not just store them as a gallery.
  ipcMain.handle(channels.IPC_ADD_LECTURE_PHOTOS, async (_e, subject: string, folderName: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Фото', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled) return { fileNames: [], markdown: null };

    const raw = library.loadLectureRaw(settings.libraryPath, subject, folderName) ?? { transcript: [], slides: [] };
    const lastOffset = raw.transcript.length > 0 ? raw.transcript[raw.transcript.length - 1].endSec : 0;

    const fileNames: string[] = [];
    for (let i = 0; i < result.filePaths.length; i++) {
      const filePath = result.filePaths[i];
      const ext = path.extname(filePath).slice(1).toLowerCase() || 'jpg';
      const base64Data = fs.readFileSync(filePath).toString('base64');
      fileNames.push(library.addLecturePhoto(settings.libraryPath, subject, folderName, base64Data, ext));

      // One Gemini call per photo (never all of them in a single request),
      // and paced a bit - a big batch fired all at once is exactly what
      // trips the free-tier rate limit, even though each call already
      // retries with backoff/key-rotation (see geminiClient's callGemini).
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        const description = await describePhoto(base64Data, mimeTypeForFile(filePath));
        raw.slides.push({ offsetSec: lastOffset, content: description.trim(), source: 'file' });
      } catch (err) {
        logError('Failed to describe attached photo for notes', err);
      }
    }
    library.saveLectureRaw(settings.libraryPath, subject, folderName, raw);

    let markdown: string | null = null;
    try {
      markdown = await buildLectureNotes(raw.transcript, raw.slides, []);
      library.saveLectureMarkdown(settings.libraryPath, subject, folderName, markdown, false);
    } catch (err) {
      logError('Failed to rebuild notes after attaching photos', err);
    }

    return { fileNames, markdown };
  });
  ipcMain.handle(channels.IPC_DELETE_LECTURE_PHOTO, (_e, subject: string, folderName: string, fileName: string) =>
    library.deleteLecturePhoto(settings.libraryPath, subject, folderName, fileName)
  );
  ipcMain.handle(channels.IPC_GET_LECTURE_PHOTO, (_e, subject: string, folderName: string, fileName: string) => {
    const buffer = library.loadLecturePhoto(settings.libraryPath, subject, folderName, fileName);
    return `data:${mimeTypeForFile(fileName)};base64,${buffer.toString('base64')}`;
  });

  ipcMain.handle(channels.IPC_LIST_SCHEDULE, () => schedule.listSchedule(settings.libraryPath));
  ipcMain.handle(channels.IPC_SAVE_SCHEDULE_ENTRY, (_e, entry: Omit<schedule.ScheduleEntry, 'id'> & { id?: string }) =>
    schedule.saveScheduleEntry(settings.libraryPath, entry)
  );
  ipcMain.handle(channels.IPC_DELETE_SCHEDULE_ENTRY, (_e, id: string) =>
    schedule.deleteScheduleEntry(settings.libraryPath, id)
  );
  ipcMain.handle(channels.IPC_SAVE_LECTURE_MARKDOWN, (_e, subject: string, folderName: string, markdown: string) =>
    library.saveLectureMarkdown(settings.libraryPath, subject, folderName, markdown)
  );
  ipcMain.handle(channels.IPC_RENAME_LECTURE, (_e, subject: string, folderName: string, newTitle: string) =>
    library.renameLecture(settings.libraryPath, subject, folderName, newTitle)
  );
  ipcMain.handle(channels.IPC_DELETE_LECTURE, (_e, subject: string, folderName: string) =>
    library.deleteLecture(settings.libraryPath, subject, folderName)
  );
  ipcMain.handle(channels.IPC_SEARCH_LECTURES, (_e, query: string) => library.searchLibrary(settings.libraryPath, query));

  ipcMain.handle(channels.IPC_SET_CURRENT_SUBJECT, (_e, subject: string) => {
    settings.lastSubject = subject;
    saveSettings(settings);
  });
  ipcMain.handle(channels.IPC_SET_RECORDING_TARGET, (_e, folderName: string | null) => {
    targetLectureFolder = folderName;
  });
  ipcMain.handle(channels.IPC_CHOOSE_LIBRARY_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    settings.libraryPath = result.filePaths[0];
    saveSettings(settings);
    return settings.libraryPath;
  });
  ipcMain.handle(channels.IPC_REVEAL_LIBRARY_FOLDER, () => {
    library.ensureLibraryRoot(settings.libraryPath);
    shell.openPath(settings.libraryPath);
  });

  ipcMain.handle(channels.IPC_GET_LIBRARY_STATS, () => library.getLibraryStats(settings.libraryPath));

  ipcMain.handle(channels.IPC_GENERATE_QUIZ, async (_e, subject: string, folderName: string) => {
    const markdown = library.loadLectureMarkdown(settings.libraryPath, subject, folderName);
    try {
      return await generateQuizFromNotes(markdown);
    } catch (err) {
      logError('Failed to generate quiz', err);
      throw err;
    }
  });

  // Flashcards with spaced repetition (see storage/flashcardStore.ts).
  ipcMain.handle(channels.IPC_GENERATE_FLASHCARDS, async (_e, subject: string, folderName: string) => {
    const markdown = library.loadLectureMarkdown(settings.libraryPath, subject, folderName);
    try {
      const pairs = await generateFlashcardPairsFromNotes(markdown);
      const cards = flashcards.createCardsFromPairs(pairs);
      flashcards.saveFlashcards(settings.libraryPath, subject, folderName, cards);
      return cards;
    } catch (err) {
      logError('Failed to generate flashcards', err);
      throw err;
    }
  });
  ipcMain.handle(channels.IPC_LOAD_FLASHCARDS, (_e, subject: string, folderName: string) =>
    flashcards.loadFlashcards(settings.libraryPath, subject, folderName)
  );
  ipcMain.handle(
    channels.IPC_REVIEW_FLASHCARD,
    (_e, subject: string, folderName: string, cardId: string, rating: flashcards.ReviewRating) => {
      const cards = flashcards.loadFlashcards(settings.libraryPath, subject, folderName);
      const updated = cards.map((c) => (c.id === cardId ? flashcards.reviewCard(c, rating) : c));
      flashcards.saveFlashcards(settings.libraryPath, subject, folderName, updated);
      return updated.find((c) => c.id === cardId) ?? null;
    }
  );
  ipcMain.handle(channels.IPC_LIST_DUE_FLASHCARDS, () => flashcards.listDueFlashcards(settings.libraryPath));

  ipcMain.handle(channels.IPC_FIND_IN_PAGE, (_e, text: string, forward: boolean, findNext: boolean) => {
    if (!text) {
      mainWindow?.webContents.stopFindInPage('clearSelection');
      return;
    }
    mainWindow?.webContents.findInPage(text, { forward, findNext });
  });
  ipcMain.handle(channels.IPC_STOP_FIND_IN_PAGE, () => {
    mainWindow?.webContents.stopFindInPage('clearSelection');
  });

  // Exports a note's already-rendered HTML (from the renderer's own
  // renderMarkdown, so headings/bullets/KaTeX math are already real markup)
  // to a standalone PDF, or a plain .doc that Word opens as HTML.
  ipcMain.handle(
    channels.IPC_EXPORT_NOTE,
    async (_e, title: string, bodyHtml: string, format: 'pdf' | 'doc') => {
      const safeName = title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Конспект';
      const result = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: `${safeName}.${format}`,
        filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Word', extensions: ['doc'] }],
      });
      if (result.canceled || !result.filePath) return { saved: false };

      const fullHtml = buildExportHtml(title, bodyHtml);

      if (format === 'doc') {
        fs.writeFileSync(result.filePath, fullHtml, 'utf-8');
        return { saved: true };
      }

      // PDF via a hidden window's own print pipeline - no extra dependency
      // needed, Electron/Chromium already does this natively.
      const tempHtmlPath = path.join(app.getPath('temp'), `ruby-export-${Date.now()}.html`);
      fs.writeFileSync(tempHtmlPath, fullHtml, 'utf-8');
      const pdfWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await pdfWindow.loadFile(tempHtmlPath);
        const pdfBuffer = await pdfWindow.webContents.printToPDF({});
        fs.writeFileSync(result.filePath, pdfBuffer);
      } finally {
        pdfWindow.destroy();
        fs.unlink(tempHtmlPath, () => undefined);
      }
      return { saved: true };
    }
  );
}

function escapeHtmlServer(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wraps a note's rendered HTML into a standalone document for export - inlines KaTeX's CSS with its font url()s rewritten to absolute file:// paths, since the export lives outside renderer/ where those relative paths would otherwise resolve to nothing. */
function buildExportHtml(title: string, bodyHtml: string): string {
  const katexDir = path.join(__dirname, '..', 'renderer', 'vendor', 'katex');
  const fontsUrl = `file://${path.join(katexDir, 'fonts').replace(/\\/g, '/')}/`;
  let katexCss = '';
  try {
    katexCss = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf-8').replace(/url\(fonts\//g, `url(${fontsUrl}`);
  } catch {
    // Export still works without math styling if the vendored CSS is somehow missing.
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${katexCss}
body { font-family: -apple-system, 'Segoe UI', sans-serif; color: #16090c; padding: 32px; max-width: 760px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 18px; }
h2, h3, h4 { margin: 20px 0 8px; }
ul { padding-left: 20px; }
li { margin-bottom: 6px; }
p { margin: 8px 0; }
strong { color: #b3273e; }
</style>
</head>
<body>
<h1>${escapeHtmlServer(title)}</h1>
${bodyHtml}
</body>
</html>`;
}

app.whenReady().then(() => {
  // No File/Edit/View/Window/Help menu bar - the app has its own tabs/header.
  Menu.setApplicationMenu(null);

  setApiKeys(loadApiKeys());
  setGroqApiKey(loadGroqApiKey());

  createWindow();
  mainWindow?.show(); // open visibly on launch, like a normal app; tray/hotkey take over from there
  createTray();
  setupIpcHandlers();
  setupWsServer();

  globalShortcut.register(settings.toggleHotkey, toggleWindow);

  startScheduleNotifier(
    () => schedule.listSchedule(settings.libraryPath),
    () => {
      mainWindow?.show();
      mainWindow?.focus();
    }
  );
});

app.on('window-all-closed', () => {
  // Tray app: stay alive even with no window open (except on macOS default,
  // which doesn't apply here since this targets Windows).
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
