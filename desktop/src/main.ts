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
import { SlidePipeline, SlideEntry } from './slides/slidePipeline';
import { buildLectureNotes } from './gemini/notesBuilder';
import { setApiKeys, isApiKeyConfigured, streamChatReply } from './gemini/geminiClient';
import { saveApiKey, loadApiKeys, clearApiKey } from './secrets';
import * as library from './storage/libraryStore';
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
// If set, the next "stop" appends to this existing lecture instead of
// creating a new one - picked via the "Лекция" dropdown on the Live tab.
let targetLectureFolder: string | null = null;

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
  slidePipeline = new SlidePipeline();
  audioPipeline = new AudioPipeline({
    onSegment: (segment) => {
      transcript.push(segment);
      sendToRenderer(channels.IPC_TRANSCRIPT_SEGMENT, segment);
      checkCallOut(segment.text);
    },
    onError: (err) => logError('Gemini transcription error', err),
  });
}

/** Starts a fresh lecture session - used by both the extension (over WS) and the in-app mic recorder. */
function startNewSession(tabTitle: string, tabUrl: string): void {
  resetLectureState();
  currentSession = { tabTitle, tabUrl, startedAt: Date.now() };
  sendToRenderer(channels.IPC_CONNECTION_STATUS, true, tabTitle);
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
  const durationSec = (Date.now() - currentSession.startedAt) / 1000;

  // Enqueuing a chunk only schedules its Gemini transcription - it doesn't
  // wait for it. Without this, "stop" right after speaking would build notes
  // before the last (or, for a short recording, the only) chunk came back.
  await audioPipeline?.waitForIdle();

  let markdown: string;
  let notesFailed = false;
  try {
    markdown = await buildLectureNotes(transcript, slidePipeline.slides);
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

  const raw = { transcript, slides: slidePipeline.slides };

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
      const markdown = await buildLectureNotes(transcript, slidePipeline.slides);
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
      scope: { subject: string | null; folderName: string | null },
      history: { role: 'user' | 'model'; text: string }[],
      message: string
    ) => {
      const isGlobal = !scope.subject;
      const context = isGlobal
        ? library.buildFullLibraryContext(settings.libraryPath)
        : library.buildChatContext(settings.libraryPath, scope.subject!, scope.folderName ?? undefined);
      try {
        return await streamChatReply(context, history, message, isGlobal, (delta) => {
          sendToRenderer(channels.IPC_CHAT_STREAM_DELTA, delta);
        });
      } catch (err) {
        logError('Chat request failed', err);
        throw err;
      }
    }
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
  ipcMain.handle(channels.IPC_REBUILD_LECTURE_NOTES, async (_e, subject: string, folderName: string) => {
    const raw = library.loadLectureRaw(settings.libraryPath, subject, folderName);
    if (!raw) throw new Error('Для этой лекции не сохранена исходная запись - пересборка недоступна.');
    const markdown = await buildLectureNotes(raw.transcript, raw.slides);
    library.saveLectureMarkdown(settings.libraryPath, subject, folderName, markdown, false);
    return markdown;
  });
  ipcMain.handle(channels.IPC_CREATE_LECTURE, (_e, subject: string, title: string) =>
    library.saveLecture(settings.libraryPath, subject, { title, sourceUrl: '', durationSec: 0, markdown: '' })
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
  ipcMain.handle(channels.IPC_SEARCH_LECTURES, (_e, query: string) => library.searchLectures(settings.libraryPath, query));

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
}

app.whenReady().then(() => {
  // No File/Edit/View/Window/Help menu bar - the app has its own tabs/header.
  Menu.setApplicationMenu(null);

  setApiKeys(loadApiKeys());

  createWindow();
  mainWindow?.show(); // open visibly on launch, like a normal app; tray/hotkey take over from there
  createTray();
  setupIpcHandlers();
  setupWsServer();

  globalShortcut.register(settings.toggleHotkey, toggleWindow);
});

app.on('window-all-closed', () => {
  // Tray app: stay alive even with no window open (except on macOS default,
  // which doesn't apply here since this targets Windows).
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
