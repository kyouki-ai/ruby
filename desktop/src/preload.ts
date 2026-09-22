import { contextBridge, ipcRenderer } from 'electron';
import * as channels from './ipc/channels';
import type { AppSettings } from './config';
import type { LectureMeta, LectureRawMaterial, LibraryStats, SearchResults } from './storage/libraryStore';
import type { ChatThread, ChatThreadMeta } from './storage/chatStore';
import type { AssignmentEntry } from './assignments/assignmentDetector';
import type { NotesDetailLevel } from './gemini/notesBuilder';

// Everything the renderer is allowed to touch. No direct Node/Electron
// access is exposed - only this narrow, typed surface.
contextBridge.exposeInMainWorld('lectureApp', {
  onConnectionStatus: (cb: (connected: boolean, tabTitle?: string) => void) =>
    ipcRenderer.on(channels.IPC_CONNECTION_STATUS, (_e, connected, tabTitle) => cb(connected, tabTitle)),

  onTranscriptSegment: (cb: (segment: { startSec: number; endSec: number; text: string }) => void) =>
    ipcRenderer.on(channels.IPC_TRANSCRIPT_SEGMENT, (_e, segment) => cb(segment)),

  onAssignmentDetected: (cb: (entry: AssignmentEntry) => void) =>
    ipcRenderer.on(channels.IPC_ASSIGNMENT_DETECTED, (_e, entry) => cb(entry)),

  onSlideAdded: (cb: (slide: { offsetSec: number; content: string; source: string }) => void) =>
    ipcRenderer.on(channels.IPC_SLIDE_ADDED, (_e, slide) => cb(slide)),

  onSlidePreview: (cb: (preview: { screenshotBase64: string; offsetSec: number }) => void) =>
    ipcRenderer.on(channels.IPC_SLIDE_PREVIEW, (_e, preview) => cb(preview)),

  onNotesUpdated: (cb: (markdown: string) => void) =>
    ipcRenderer.on(channels.IPC_NOTES_UPDATED, (_e, markdown) => cb(markdown)),

  onLectureSaved: (cb: (meta: LectureMeta) => void) =>
    ipcRenderer.on(channels.IPC_LECTURE_SAVED, (_e, meta) => cb(meta)),

  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(channels.IPC_GET_SETTINGS),
  saveSettings: (settings: AppSettings): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_SAVE_SETTINGS, settings),

  copyNotes: (markdown: string): Promise<void> => ipcRenderer.invoke(channels.IPC_COPY_NOTES, markdown),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke(channels.IPC_COPY_TEXT, text),
  copyAssignmentPrompt: (promptText: string, screenshotBase64: string | null): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_COPY_ASSIGNMENT_PROMPT, promptText, screenshotBase64),
  openExtensionFolder: (): Promise<void> => ipcRenderer.invoke(channels.IPC_OPEN_EXTENSION_FOLDER),

  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(channels.IPC_WINDOW_MINIMIZE),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke(channels.IPC_WINDOW_MAXIMIZE_TOGGLE),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(channels.IPC_WINDOW_CLOSE),

  startMicSession: (): Promise<void> => ipcRenderer.invoke(channels.IPC_START_MIC_SESSION),
  sendMicAudioChunk: (pcmBase64: string, startOffsetSec: number, durationSec: number): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_MIC_AUDIO_CHUNK, pcmBase64, startOffsetSec, durationSec),
  stopMicSession: (): Promise<void> => ipcRenderer.invoke(channels.IPC_STOP_MIC_SESSION),

  attachSlideFile: (): Promise<{ offsetSec: number; content: string; source: string } | null> =>
    ipcRenderer.invoke(channels.IPC_ATTACH_SLIDE_FILE),

  getExtensionReady: (): Promise<boolean> => ipcRenderer.invoke(channels.IPC_GET_EXTENSION_READY),
  onExtensionReady: (cb: (ready: boolean) => void) =>
    ipcRenderer.on(channels.IPC_EXTENSION_READY, (_e, ready) => cb(ready)),
  remoteStartRecording: (mode: 'tab-slides' | 'tab-audio-only'): Promise<boolean> =>
    ipcRenderer.invoke(channels.IPC_REMOTE_START_RECORDING, mode),
  remoteStopRecording: (): Promise<boolean> => ipcRenderer.invoke(channels.IPC_REMOTE_STOP_RECORDING),

  chatSend: (
    threadId: string,
    history: { role: 'user' | 'model'; text: string }[],
    message: string
  ): Promise<string> => ipcRenderer.invoke(channels.IPC_CHAT_SEND, threadId, history, message),
  onChatStreamDelta: (cb: (delta: string) => void) =>
    ipcRenderer.on(channels.IPC_CHAT_STREAM_DELTA, (_e, delta) => cb(delta)),

  listChatThreads: (): Promise<ChatThreadMeta[]> => ipcRenderer.invoke(channels.IPC_LIST_CHAT_THREADS),
  createChatThread: (title: string): Promise<ChatThread> =>
    ipcRenderer.invoke(channels.IPC_CREATE_CHAT_THREAD, title),
  loadChatThread: (id: string): Promise<ChatThread | null> => ipcRenderer.invoke(channels.IPC_LOAD_CHAT_THREAD, id),
  renameChatThread: (id: string, title: string): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_RENAME_CHAT_THREAD, id, title),
  deleteChatThread: (id: string): Promise<void> => ipcRenderer.invoke(channels.IPC_DELETE_CHAT_THREAD, id),
  findOrCreateLectureThread: (subject: string, folderName: string | null, title: string): Promise<ChatThread> =>
    ipcRenderer.invoke(channels.IPC_FIND_OR_CREATE_LECTURE_THREAD, subject, folderName, title),

  getApiStatus: (): Promise<{ configured: boolean }> => ipcRenderer.invoke(channels.IPC_GET_API_STATUS),
  saveApiKey: (key: string): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke(channels.IPC_SAVE_API_KEY, key),
  clearApiKey: (): Promise<{ configured: boolean }> => ipcRenderer.invoke(channels.IPC_CLEAR_API_KEY),

  getGroqApiStatus: (): Promise<{ configured: boolean }> => ipcRenderer.invoke(channels.IPC_GET_GROQ_API_STATUS),
  saveGroqApiKey: (key: string): Promise<{ configured: boolean }> =>
    ipcRenderer.invoke(channels.IPC_SAVE_GROQ_API_KEY, key),
  clearGroqApiKey: (): Promise<{ configured: boolean }> => ipcRenderer.invoke(channels.IPC_CLEAR_GROQ_API_KEY),

  listSubjects: (): Promise<string[]> => ipcRenderer.invoke(channels.IPC_LIST_SUBJECTS),
  createSubject: (name: string): Promise<string> => ipcRenderer.invoke(channels.IPC_CREATE_SUBJECT, name),
  renameSubject: (oldName: string, newName: string): Promise<string> =>
    ipcRenderer.invoke(channels.IPC_RENAME_SUBJECT, oldName, newName),
  deleteSubject: (name: string): Promise<void> => ipcRenderer.invoke(channels.IPC_DELETE_SUBJECT, name),

  listLectures: (subject: string): Promise<LectureMeta[]> =>
    ipcRenderer.invoke(channels.IPC_LIST_LECTURES, subject),
  loadLecture: (subject: string, folderName: string): Promise<string> =>
    ipcRenderer.invoke(channels.IPC_LOAD_LECTURE, subject, folderName),
  loadLectureRaw: (subject: string, folderName: string): Promise<LectureRawMaterial | null> =>
    ipcRenderer.invoke(channels.IPC_LOAD_LECTURE_RAW, subject, folderName),
  rebuildLectureNotes: (subject: string, folderName: string, detailLevel?: NotesDetailLevel): Promise<string> =>
    ipcRenderer.invoke(channels.IPC_REBUILD_LECTURE_NOTES, subject, folderName, detailLevel),
  createLecture: (subject: string, title: string): Promise<LectureMeta> =>
    ipcRenderer.invoke(channels.IPC_CREATE_LECTURE, subject, title),
  saveLectureMarkdown: (subject: string, folderName: string, markdown: string): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_SAVE_LECTURE_MARKDOWN, subject, folderName, markdown),
  renameLecture: (subject: string, folderName: string, newTitle: string): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_RENAME_LECTURE, subject, folderName, newTitle),
  deleteLecture: (subject: string, folderName: string): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_DELETE_LECTURE, subject, folderName),
  searchLectures: (query: string): Promise<SearchResults> =>
    ipcRenderer.invoke(channels.IPC_SEARCH_LECTURES, query),

  setCurrentSubject: (subject: string): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_SET_CURRENT_SUBJECT, subject),
  setRecordingTarget: (folderName: string | null): Promise<void> =>
    ipcRenderer.invoke(channels.IPC_SET_RECORDING_TARGET, folderName),
  chooseLibraryFolder: (): Promise<string | null> => ipcRenderer.invoke(channels.IPC_CHOOSE_LIBRARY_FOLDER),
  revealLibraryFolder: (): Promise<void> => ipcRenderer.invoke(channels.IPC_REVEAL_LIBRARY_FOLDER),
  getLibraryStats: (): Promise<LibraryStats> => ipcRenderer.invoke(channels.IPC_GET_LIBRARY_STATS),
  generateQuiz: (subject: string, folderName: string): Promise<string> =>
    ipcRenderer.invoke(channels.IPC_GENERATE_QUIZ, subject, folderName),
});
