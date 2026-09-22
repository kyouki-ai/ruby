// IPC channel names shared between main and renderer via preload's contextBridge.

// main -> renderer (event push)
export const IPC_CONNECTION_STATUS = 'connection-status';
export const IPC_TRANSCRIPT_SEGMENT = 'transcript-segment';
export const IPC_SLIDE_ADDED = 'slide-added';
export const IPC_SLIDE_PREVIEW = 'slide-preview';
export const IPC_NOTES_UPDATED = 'notes-updated';
export const IPC_LECTURE_SAVED = 'lecture-saved';
export const IPC_EXTENSION_READY = 'extension-ready';

// renderer -> main (invoke/request-response)
export const IPC_GET_SETTINGS = 'get-settings';
export const IPC_SAVE_SETTINGS = 'save-settings';
export const IPC_COPY_NOTES = 'copy-notes';
export const IPC_COPY_TEXT = 'copy-text';
export const IPC_OPEN_EXTENSION_FOLDER = 'open-extension-folder';

// Custom window chrome (the OS title bar is disabled - see main.ts createWindow).
export const IPC_WINDOW_MINIMIZE = 'window-minimize';
export const IPC_WINDOW_MAXIMIZE_TOGGLE = 'window-maximize-toggle';
export const IPC_WINDOW_CLOSE = 'window-close';

// In-app microphone recording - no browser/extension needed for an
// in-person lecture. The renderer captures and downsamples audio itself
// and streams chunks over IPC instead of the WebSocket the extension uses.
export const IPC_START_MIC_SESSION = 'start-mic-session';
export const IPC_MIC_AUDIO_CHUNK = 'mic-audio-chunk';
export const IPC_STOP_MIC_SESSION = 'stop-mic-session';

// Attach an existing slide deck file (PDF/image) instead of live-capturing
// slides via the browser extension.
export const IPC_ATTACH_SLIDE_FILE = 'attach-slide-file';

// Tell the browser extension to start recording on its own, instead of the
// user opening the popup and clicking a mode button themselves.
export const IPC_REMOTE_START_RECORDING = 'remote-start-recording';
export const IPC_REMOTE_STOP_RECORDING = 'remote-stop-recording';
export const IPC_GET_EXTENSION_READY = 'get-extension-ready';

// Study-assistant chat, grounded in a subject's or one lecture's saved notes.
export const IPC_CHAT_SEND = 'chat-send';
// Pushed repeatedly during a chat-send call as the reply streams in.
export const IPC_CHAT_STREAM_DELTA = 'chat-stream-delta';

// API key
export const IPC_GET_API_STATUS = 'get-api-status';
export const IPC_SAVE_API_KEY = 'save-api-key';
export const IPC_CLEAR_API_KEY = 'clear-api-key';

// Groq key - optional, only used for audio transcription.
export const IPC_GET_GROQ_API_STATUS = 'get-groq-api-status';
export const IPC_SAVE_GROQ_API_KEY = 'save-groq-api-key';
export const IPC_CLEAR_GROQ_API_KEY = 'clear-groq-api-key';

// Library: subjects (folders) and lectures (sub-folders)
export const IPC_LIST_SUBJECTS = 'list-subjects';
export const IPC_CREATE_SUBJECT = 'create-subject';
export const IPC_RENAME_SUBJECT = 'rename-subject';
export const IPC_DELETE_SUBJECT = 'delete-subject';
export const IPC_LIST_LECTURES = 'list-lectures';
export const IPC_LOAD_LECTURE = 'load-lecture';
export const IPC_LOAD_LECTURE_RAW = 'load-lecture-raw';
export const IPC_REBUILD_LECTURE_NOTES = 'rebuild-lecture-notes';
export const IPC_CREATE_LECTURE = 'create-lecture';
export const IPC_SAVE_LECTURE_MARKDOWN = 'save-lecture-markdown';
export const IPC_RENAME_LECTURE = 'rename-lecture';
export const IPC_DELETE_LECTURE = 'delete-lecture';
export const IPC_SEARCH_LECTURES = 'search-lectures';
export const IPC_SET_CURRENT_SUBJECT = 'set-current-subject';
export const IPC_SET_RECORDING_TARGET = 'set-recording-target';
export const IPC_CHOOSE_LIBRARY_FOLDER = 'choose-library-folder';
export const IPC_REVEAL_LIBRARY_FOLDER = 'reveal-library-folder';
export const IPC_GET_LIBRARY_STATS = 'get-library-stats';
export const IPC_GENERATE_QUIZ = 'generate-quiz';

// Live detection of a spoken task/homework announcement (see
// assignments/assignmentDetector.ts) - pushed as it happens during
// recording, plus a way to copy one (text + slide image) to the clipboard.
export const IPC_ASSIGNMENT_DETECTED = 'assignment-detected';
export const IPC_COPY_ASSIGNMENT_PROMPT = 'copy-assignment-prompt';

// Named, persisted chat threads (see storage/chatStore.ts) - the chat used
// to live only in renderer memory and vanished on every restart.
export const IPC_LIST_CHAT_THREADS = 'list-chat-threads';
export const IPC_CREATE_CHAT_THREAD = 'create-chat-thread';
export const IPC_LOAD_CHAT_THREAD = 'load-chat-thread';
export const IPC_RENAME_CHAT_THREAD = 'rename-chat-thread';
export const IPC_DELETE_CHAT_THREAD = 'delete-chat-thread';
export const IPC_FIND_OR_CREATE_LECTURE_THREAD = 'find-or-create-lecture-thread';

// Auto-stop-on-silence: pushed while recording if silence has gone on long
// enough to warn, cleared once sound resumes or the user dismisses it.
export const IPC_SILENCE_WARNING = 'silence-warning';
export const IPC_SILENCE_WARNING_CLEARED = 'silence-warning-cleared';
export const IPC_DISMISS_SILENCE_WARNING = 'dismiss-silence-warning';

// Flashcards with spaced repetition, generated from a lecture's notes (see
// storage/flashcardStore.ts).
export const IPC_GENERATE_FLASHCARDS = 'generate-flashcards';
export const IPC_LOAD_FLASHCARDS = 'load-flashcards';
export const IPC_REVIEW_FLASHCARD = 'review-flashcard';
export const IPC_LIST_DUE_FLASHCARDS = 'list-due-flashcards';

// Exporting a rendered note to a file (PDF, or a Word-openable .doc).
export const IPC_EXPORT_NOTE = 'export-note';

// In-page search (Ctrl+F) - thin wrapper around Electron's own
// webContents.findInPage, since there's no built-in find bar for a custom
// BrowserWindow the way there is in a real browser tab.
export const IPC_FIND_IN_PAGE = 'find-in-page';
export const IPC_STOP_FIND_IN_PAGE = 'stop-find-in-page';
export const IPC_FOUND_IN_PAGE = 'found-in-page';
