// Plain-JS renderer logic. Runs in the isolated renderer context; the only
// bridge to the main process is `window.lectureApp`, exposed by preload.ts.
// `icon()` / `ICONS` come from icons.js, loaded before this file.

// --- Modal dialogs (Electron does not implement window.prompt - it silently
// returns null - so text input and confirmation both go through this). ---
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalInput = document.getElementById('modal-input');
const modalOkBtn = document.getElementById('modal-ok-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');

function closeModal(result) {
  modalOverlay.style.display = 'none';
  if (modalOverlay._resolve) modalOverlay._resolve(result);
}

modalCancelBtn.addEventListener('click', () => closeModal(null));
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal(null);
});
modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeModal(modalInput.value.trim() || null);
  if (e.key === 'Escape') closeModal(null);
});

/** Text-input modal. Resolves to the trimmed string, or null if cancelled/empty. */
function askText(title, defaultValue = '') {
  modalTitle.textContent = title;
  modalMessage.style.display = 'none';
  modalInput.style.display = 'block';
  modalInput.value = defaultValue;
  modalOkBtn.textContent = 'ОК';
  modalOkBtn.onclick = () => closeModal(modalInput.value.trim() || null);
  modalOverlay.style.display = 'flex';
  setTimeout(() => modalInput.select(), 0);
  return new Promise((resolve) => { modalOverlay._resolve = resolve; });
}

/** Yes/no modal. Resolves to true/false. */
function askConfirm(title, message) {
  modalTitle.textContent = title;
  modalMessage.textContent = message;
  modalMessage.style.display = 'block';
  modalInput.style.display = 'none';
  modalOkBtn.textContent = 'Удалить';
  modalOkBtn.onclick = () => closeModal(true);
  modalOverlay.style.display = 'flex';
  return new Promise((resolve) => { modalOverlay._resolve = (v) => resolve(Boolean(v)); });
}

/** Tiny markdown -> HTML renderer covering just what notesBuilder.ts produces. */
function renderMarkdown(markdown) {
  const lines = markdown.split('\n');
  let html = '';
  let inList = false;

  const closeList = () => {
    if (inList) { html += '</ul>'; inList = false; }
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)/.exec(line);
    const bullet = /^[-*]\s+(.*)/.exec(line);

    if (heading) {
      closeList();
      const level = heading[1].length + 1; // ## -> h3
      html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
    } else if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMarkdown(bullet[1])}</li>`;
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inlineMarkdown(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function inlineMarkdown(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTimestamp(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

/** Deterministic color tile (1-6) for a subject name, so the same subject always looks the same. */
function tileClassFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `tile-${(hash % 6) + 1}`;
}

// --- Dropdown menu (used by the "..." button on subject/lecture cards) ---
let openMenuEl = null;

function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}
document.addEventListener('click', closeMenu);

function openMenu(anchorEl, items) {
  closeMenu();
  const rect = anchorEl.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'dropdown-menu';
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.right - 150}px`;

  for (const item of items) {
    const btn = document.createElement('button');
    if (item.danger) btn.className = 'danger';
    btn.innerHTML = `${icon(item.icon, 15)}<span>${escapeHtml(item.label)}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      item.onClick();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  openMenuEl = menu;
}

// --- Theme (dark/light, remembered per-machine via localStorage) ---
const themeToggleBtn = document.getElementById('theme-toggle-btn');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggleBtn.innerHTML = icon(theme === 'light' ? 'moon' : 'sun', 17);
  themeToggleBtn.title = theme === 'light' ? 'Тёмная тема' : 'Светлая тема';
}

function initTheme() {
  let saved = 'dark';
  try {
    saved = localStorage.getItem('theme') || 'dark';
  } catch {
    // localStorage can throw in locked-down contexts - dark is a safe default.
  }
  applyTheme(saved);
}

themeToggleBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem('theme', next);
  } catch {
    // Ignore - theme just won't persist across restarts.
  }
});

initTheme();

// --- Window controls (no OS title bar - see main.ts, frame: false) ---
document.getElementById('win-minimize-btn').innerHTML = icon('winMinimize', 15);
document.getElementById('win-maximize-btn').innerHTML = icon('winMaximize', 13);
document.getElementById('win-close-btn').innerHTML = icon('winClose', 15);
document.getElementById('win-minimize-btn').addEventListener('click', () => window.lectureApp.minimizeWindow());
document.getElementById('win-maximize-btn').addEventListener('click', () => window.lectureApp.toggleMaximizeWindow());
document.getElementById('win-close-btn').addEventListener('click', () => window.lectureApp.closeWindow());

// --- Static icon buttons ---
document.getElementById('copy-btn').innerHTML = `${icon('copy', 15)}<span>Копировать</span>`;
document.getElementById('lib-back-btn').innerHTML = icon('chevronLeft', 18);
document.getElementById('search-icon').innerHTML = icon('search', 16);

document.getElementById('copy-chrome-url-btn').addEventListener('click', (e) => {
  window.lectureApp.copyText('chrome://extensions');
  const original = e.currentTarget.textContent;
  e.currentTarget.textContent = 'Скопировано';
  setTimeout(() => (e.currentTarget.textContent = original), 1500);
});

document.getElementById('open-extension-folder-btn').addEventListener('click', () => {
  window.lectureApp.openExtensionFolder();
});

// --- Views: the app opens straight into the AI chat (no folder to pick
// first) - "Мои предметы" is one toggle away for browsing/recording.
// Settings and the recording screen are reached via icon buttons /
// navigation from inside either, each with its own way back. ---
let lastMainMode = 'chat'; // remembers chat vs. library so settings/help "back" returns to the right one

function switchToTab(tabName) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabName}`));
  // The chat/library toggle only reflects those two modes - settings and the
  // recording screen are reached "on top" of whichever mode you were in.
  if (tabName === 'chat' || tabName === 'history') {
    document.getElementById('mode-chat-btn').classList.toggle('active', tabName === 'chat');
    document.getElementById('mode-library-btn').classList.toggle('active', tabName === 'history');
    lastMainMode = tabName;
  }
}

function backToMainMode() {
  if (lastMainMode === 'chat') openChat(chatScope, chatScope ? chatScope.subject : 'Все предметы');
  else {
    switchToTab('history');
    openSubjectGrid();
  }
}

document.getElementById('mode-chat-btn').addEventListener('click', () => openChat(null, 'Все предметы'));
document.getElementById('mode-library-btn').addEventListener('click', () => {
  switchToTab('history');
  openSubjectGrid();
});

document.getElementById('settings-btn').innerHTML = icon('gear', 17);
document.getElementById('settings-btn').addEventListener('click', () => switchToTab('settings'));
document.getElementById('settings-back-btn').innerHTML = icon('chevronLeft', 18);
document.getElementById('settings-back-btn').addEventListener('click', backToMainMode);

document.getElementById('help-btn').innerHTML = icon('help', 17);
document.getElementById('help-close-btn').innerHTML = icon('winClose', 15);
function openHelpModal() {
  document.getElementById('help-modal-overlay').style.display = 'flex';
}
function closeHelpModal() {
  document.getElementById('help-modal-overlay').style.display = 'none';
}
document.getElementById('help-btn').addEventListener('click', openHelpModal);
document.getElementById('help-close-btn').addEventListener('click', closeHelpModal);
document.getElementById('help-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'help-modal-overlay') closeHelpModal();
});
document.getElementById('live-help-link').addEventListener('click', (e) => {
  e.preventDefault();
  openHelpModal();
});

document.getElementById('live-back-btn').innerHTML = icon('chevronLeft', 18);
document.getElementById('live-back-btn').addEventListener('click', () => {
  switchToTab('history');
  openSubjectGrid();
});

// --- Live tab: connection status + transcript + notes ---
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const transcriptBox = document.getElementById('transcript');
const notesBox = document.getElementById('notes');

let wasRecordingConnected = false;
// Set while finalizeSession() is building the conspect after Stop was
// clicked - the WS/mic connection already dropped by this point (a normal
// side effect of stopping), but the recording screen must stay put showing
// "Собираю конспект..." instead of snapping back to the mode-picker, which
// otherwise reads as "it forgot my recording" for however long Gemini takes.
let isFinalizing = false;

// A rough, non-authoritative countdown while the conspect is being built -
// just enough to make "Собираю конспект..." look alive instead of a frozen
// spinner, since Gemini/Groq calls typically land well inside this window.
const FINALIZE_ESTIMATE_SEC = 15;
let finalizingCountdownTimer = null;

function finalizeCountdownHtml(secondsLeft) {
  return secondsLeft > 0
    ? `<p class="hint">${rubyGemSvg(13)} Собираю конспект… обычно занимает около ${FINALIZE_ESTIMATE_SEC} сек, осталось примерно ${secondsLeft}с.</p>`
    : `<p class="hint">${rubyGemSvg(13)} Ещё немного — иногда занимает дольше обычного.</p>`;
}

function startFinalizingCountdown() {
  stopFinalizingCountdown();
  let secondsLeft = FINALIZE_ESTIMATE_SEC;
  notesBox.innerHTML = finalizeCountdownHtml(secondsLeft);
  finalizingCountdownTimer = setInterval(() => {
    secondsLeft -= 1;
    notesBox.innerHTML = finalizeCountdownHtml(secondsLeft);
  }, 1000);
}

function stopFinalizingCountdown() {
  if (finalizingCountdownTimer) {
    clearInterval(finalizingCountdownTimer);
    finalizingCountdownTimer = null;
  }
}

window.lectureApp.onConnectionStatus((connected, tabTitle) => {
  statusDot.className = `dot ${connected ? 'dot-on' : 'dot-off'}`;
  statusText.textContent = connected ? `Запись: ${tabTitle || 'вкладка браузера'}` : 'Не подключено';
  const showActive = connected || isFinalizing;
  document.getElementById('live-empty-state').style.display = showActive ? 'none' : 'flex';
  document.getElementById('live-active-view').style.display = showActive ? 'flex' : 'none';
  if (connected && !wasRecordingConnected) {
    // Only jump the user to the recording screen on a genuinely new
    // recording starting - not on every reconnect ping for one already in
    // progress, which would otherwise yank them away from wherever they're
    // currently browsing in the app.
    document.getElementById('live-target-label').textContent = tabTitle || 'Запись';
    switchToTab('live');
    // Leftovers from the previous recording shown on this same screen.
    document.getElementById('live-saved-hint').style.display = 'none';
    document.getElementById('live-open-note-btn').style.display = 'none';
  }
  wasRecordingConnected = connected;
  // Shown for every active recording, not just mic ones - clicking it stops
  // whichever kind is actually running (see the click handler below).
  document.getElementById('stop-mic-btn').style.display = connected ? 'inline-flex' : 'none';
  document.getElementById('slide-preview').style.display = 'none';
  if (!connected) {
    if (isFinalizing) startFinalizingCountdown();
    return;
  }
  stopFinalizingCountdown();
  transcriptBox.innerHTML = '';
  // The structured conspect is only built once, when recording stops (see
  // main.ts) - rebuilding it continuously would burn through Gemini's free
  // daily quota well before a full day of lectures is over.
  notesBox.innerHTML = '<p class="hint">Появится здесь после остановки записи.</p>';
});

// --- In-app microphone recording (offline lecture, no browser needed) ---
// Mirrors extension/offscreen.js's PCM pipeline, but runs in this renderer
// and streams chunks over IPC instead of a WebSocket.
// Kept in sync with extension/offscreen.js's CHUNK_DURATION_SEC - see the
// comment there about free-tier Gemini quotas.
const MIC_CHUNK_DURATION_SEC = 30;
const MIC_TARGET_SAMPLE_RATE = 16000;

let micSessionActive = false;
let micAudioContext = null;
let micProcessorNode = null;
let micStreamForApp = null;
let micChunkStartOffsetSec = 0;
let micPcmBuffer = [];
let micPcmBufferedSamples = 0;

function micDownsampleTo16k(float32Samples, inputSampleRate) {
  if (inputSampleRate === MIC_TARGET_SAMPLE_RATE) return float32Samples;
  const ratio = inputSampleRate / MIC_TARGET_SAMPLE_RATE;
  const outLength = Math.floor(float32Samples.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const lo = Math.floor(srcIndex);
    const hi = Math.min(lo + 1, float32Samples.length - 1);
    const frac = srcIndex - lo;
    out[i] = float32Samples[lo] * (1 - frac) + float32Samples[hi] * frac;
  }
  return out;
}

function micFloatTo16BitPCM(float32Samples) {
  const out = new Int16Array(float32Samples.length);
  for (let i = 0; i < float32Samples.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function micInt16ArrayToBase64(chunks) {
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const bytes = new Uint8Array(merged.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function flushMicChunk() {
  if (micPcmBufferedSamples === 0) return Promise.resolve();
  const pcmBase64 = micInt16ArrayToBase64(micPcmBuffer);
  const durationSec = micPcmBufferedSamples / MIC_TARGET_SAMPLE_RATE;
  const sendPromise = window.lectureApp.sendMicAudioChunk(pcmBase64, micChunkStartOffsetSec, durationSec);
  micChunkStartOffsetSec += durationSec;
  micPcmBuffer = [];
  micPcmBufferedSamples = 0;
  return sendPromise;
}

async function startMicRecording() {
  const micErrorEl = document.getElementById('mic-error');
  micErrorEl.textContent = '';

  try {
    micStreamForApp = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    micErrorEl.textContent = 'Доступ к микрофону не получен — разреши доступ и попробуй снова.';
    return;
  }

  micSessionActive = true;
  micChunkStartOffsetSec = 0;
  micPcmBuffer = [];
  micPcmBufferedSamples = 0;

  await window.lectureApp.startMicSession();

  micAudioContext = new AudioContext();
  // A freshly created AudioContext can start life 'suspended' (autoplay
  // policy) once we're a couple of awaits past the click that triggered
  // this - without resuming, onaudioprocess below never fires and no audio
  // ever gets sent at all.
  await micAudioContext.resume();
  const source = micAudioContext.createMediaStreamSource(micStreamForApp);
  micProcessorNode = micAudioContext.createScriptProcessor(4096, 1, 1);
  source.connect(micProcessorNode);
  micProcessorNode.connect(micAudioContext.destination);

  micProcessorNode.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = micDownsampleTo16k(input, micAudioContext.sampleRate);
    const pcm16 = micFloatTo16BitPCM(downsampled);
    micPcmBuffer.push(pcm16);
    micPcmBufferedSamples += pcm16.length;
    if (micPcmBufferedSamples / MIC_TARGET_SAMPLE_RATE >= MIC_CHUNK_DURATION_SEC) {
      flushMicChunk();
    }
  };

  document.getElementById('stop-mic-btn').style.display = 'inline-flex';
}

async function stopMicRecording() {
  if (!micSessionActive) return; // already stopping/stopped - ignore extra clicks
  micSessionActive = false;

  await flushMicChunk(); // make sure the last chunk is actually sent before we ask main to finalize
  micProcessorNode?.disconnect();
  micAudioContext?.close();
  micStreamForApp?.getTracks().forEach((track) => track.stop());
  await window.lectureApp.stopMicSession();
}

document.getElementById('start-mic-btn').innerHTML = `${icon('mic', 16)}<span>Начать запись с микрофона</span>`;
document.getElementById('start-mic-btn').addEventListener('click', startMicRecording);

// --- Remote-starting the browser extension, no popup click needed ---
// The extension's control-channel handshake can take a few seconds after the
// screen opens (service worker waking up, WS reconnect backoff) - showing the
// "extension not connected, go read the setup docs" hint immediately during
// that gap reads as "this is broken", not "still connecting". So: show a
// neutral "checking" spinner first, and only fall back to the instructional
// hint once a real grace period has passed without the extension showing up.
let extensionCheckTimer = null;
function updateExtensionReadyUi(ready) {
  clearTimeout(extensionCheckTimer);
  // 'block', not 'flex' - .setup-card's children (tag/title/buttons) stack
  // vertically as normal block flow; 'flex' laid them out as a single row.
  document.getElementById('browser-ready-card').style.display = ready ? 'block' : 'none';
  if (ready) {
    document.getElementById('browser-checking-hint').style.display = 'none';
    document.getElementById('browser-not-ready-hint').style.display = 'none';
    return;
  }
  document.getElementById('browser-checking-hint').style.display = 'flex';
  document.getElementById('browser-not-ready-hint').style.display = 'none';
  extensionCheckTimer = setTimeout(() => {
    document.getElementById('browser-checking-hint').style.display = 'none';
    document.getElementById('browser-not-ready-hint').style.display = 'block';
  }, 4000);
}
window.lectureApp.getExtensionReady().then(updateExtensionReadyUi);
window.lectureApp.onExtensionReady(updateExtensionReadyUi);

async function remoteStart(mode) {
  const errorEl = document.getElementById('remote-action-error');
  errorEl.style.display = 'none';
  const ok = await window.lectureApp.remoteStartRecording(mode);
  if (!ok) {
    // The control channel dropped between the card showing "Подключено" and
    // this click - say so instead of leaving the button looking like a dud.
    errorEl.textContent = 'Расширение отключилось. Подожди пару секунд и попробуй снова.';
    errorEl.style.display = 'block';
  }
}
document.getElementById('remote-start-slides-btn').addEventListener('click', () => remoteStart('tab-slides'));
document.getElementById('remote-start-audio-btn').addEventListener('click', () => remoteStart('tab-audio-only'));

document.getElementById('stop-mic-btn').addEventListener('click', async () => {
  const btn = document.getElementById('stop-mic-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Собираю конспект...';
  isFinalizing = true;
  startFinalizingCountdown();

  // The button must never look permanently stuck: Gemini calls inside
  // finalizeSession already time out on their own (main process side), but
  // this is a hard backstop on the UI itself regardless of what's happening
  // there. The actual finalize/save keeps running in the background either
  // way - this only affects how long the button stays disabled.
  const timeout = new Promise((resolve) => setTimeout(resolve, 30_000));

  try {
    if (micSessionActive) {
      await Promise.race([stopMicRecording(), timeout]);
    } else {
      // A browser-extension recording - tell it to stop over the same
      // always-on control channel that can start it.
      await Promise.race([window.lectureApp.remoteStopRecording(), timeout]);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    // Safety net: onLectureSaved normally clears isFinalizing well before
    // this backstop fires. If it hasn't (finalize hung or failed silently),
    // don't leave the user staring at "Собираю конспект..." forever - drop
    // back to the subjects list instead.
    if (isFinalizing) {
      isFinalizing = false;
      stopFinalizingCountdown();
      switchToTab('history');
      openSubjectGrid();
    }
  }
});

document.getElementById('attach-slide-btn').innerHTML = `${icon('file', 15)}<span>Прикрепить файл слайдов</span>`;
document.getElementById('attach-slide-btn').addEventListener('click', async () => {
  const btn = document.getElementById('attach-slide-btn');
  const original = btn.innerHTML;
  btn.innerHTML = `${icon('file', 15)}<span>Обрабатываю...</span>`;
  try {
    await window.lectureApp.attachSlideFile();
  } finally {
    btn.innerHTML = original;
  }
});

window.lectureApp.onTranscriptSegment((segment) => {
  const line = document.createElement('div');
  line.className = segment.marked ? 'transcript-line transcript-line-marked' : 'transcript-line';
  const marker = segment.marked ? `<span class="marker-star" title="Отмечено как важное">${icon('star', 12)}</span>` : '';
  line.innerHTML = `<span class="ts">[${formatTimestamp(segment.startSec)}]</span>${marker}${escapeHtml(segment.text)}`;
  transcriptBox.appendChild(line);
  transcriptBox.scrollTop = transcriptBox.scrollHeight;
});

window.lectureApp.onNotesUpdated((markdown) => {
  stopFinalizingCountdown();
  notesBox.innerHTML = renderMarkdown(markdown);
  notesBox.dataset.raw = markdown;
});

window.lectureApp.onSlidePreview(({ screenshotBase64, offsetSec }) => {
  // The extension's tab-capture occasionally comes back empty/truncated
  // (rate limits, a tab that briefly wasn't capturable) - showing that as a
  // blank thumbnail looked broken, so just keep the last good preview
  // instead of overwriting it with nothing.
  if (!screenshotBase64 || screenshotBase64.length < 100) return;
  document.getElementById('slide-preview-img').src = `data:image/jpeg;base64,${screenshotBase64}`;
  document.getElementById('slide-preview-time').textContent = `Слайд · ${formatTimestamp(offsetSec)}`;
  document.getElementById('slide-preview').style.display = 'flex';
});

window.lectureApp.onLectureSaved((meta) => {
  // Stay right here - the transcript (left) and the just-built conspect
  // (right, already pushed via onNotesUpdated above) are exactly what the
  // user was watching happen. Yanking them to the library view instead was
  // its own bug: it interrupts the result they were already looking at.
  isFinalizing = false;
  stopFinalizingCountdown();
  const savedHint = document.getElementById('live-saved-hint');
  const openNoteBtn = document.getElementById('live-open-note-btn');
  savedHint.style.display = 'inline';
  openNoteBtn.style.display = 'inline-flex';
  openNoteBtn.onclick = () => {
    switchToTab('history');
    openNote(meta.subject, meta, 'subject');
  };
});

document.getElementById('copy-btn').addEventListener('click', () => {
  window.lectureApp.copyNotes(notesBox.dataset.raw || '');
});

// --- Recording screen: reached from a specific lecture inside a subject,
// not a permanent tab. `meta` is null for a brand-new lecture (created only
// once the recording actually finishes and gets saved).
let recordingTargetSubject = null;

async function openRecordingView(subject, meta) {
  recordingTargetSubject = subject;
  await window.lectureApp.setCurrentSubject(subject);
  await window.lectureApp.setRecordingTarget(meta ? meta.folderName : null);
  document.getElementById('live-target-label').textContent = meta ? `${subject} · ${meta.title}` : `${subject} · Новая лекция`;
  switchToTab('live');
}

// --- History tab: drill-down grid (subjects -> lectures -> note) ---
const libTitle = document.getElementById('lib-title');
const libBackBtn = document.getElementById('lib-back-btn');
const libraryContent = document.getElementById('library-content');
const searchInput = document.getElementById('search-input');

const libraryState = { view: 'grid', subject: null };

searchInput.addEventListener('input', () => {
  if (searchInput.value.trim()) renderSearchResults();
  else openSubjectGrid();
});

async function openSubjectGrid() {
  libraryState.view = 'grid';
  libraryState.subject = null;
  searchInput.value = '';
  libTitle.textContent = 'Мои предметы';
  libBackBtn.style.display = 'none';
  document.getElementById('lib-chat-btn').style.display = 'none';

  const subjects = await window.lectureApp.listSubjects();
  const wrapper = document.createElement('div');

  const stats = await window.lectureApp.getLibraryStats();
  if (stats.lectureCount > 0) {
    const hours = stats.totalDurationSec / 3600;
    const hoursLabel = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
    const lastActivity = stats.lastActivityDate
      ? new Date(stats.lastActivityDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : '—';
    const statsBar = document.createElement('div');
    statsBar.className = 'library-stats';
    statsBar.innerHTML = `
      <div class="library-stat"><span class="library-stat-num">${stats.subjectCount}</span><span class="library-stat-label">${pluralForm(stats.subjectCount, 'предмет', 'предмета', 'предметов')}</span></div>
      <div class="library-stat"><span class="library-stat-num">${stats.lectureCount}</span><span class="library-stat-label">${pluralLectures(stats.lectureCount)} записано</span></div>
      <div class="library-stat"><span class="library-stat-num">${hoursLabel}</span><span class="library-stat-label">${pluralForm(Math.round(hours), 'час', 'часа', 'часов')} расшифровано</span></div>
      <div class="library-stat"><span class="library-stat-num">${lastActivity}</span><span class="library-stat-label">последняя запись</span></div>
    `;
    wrapper.appendChild(statsBar);
  }

  const grid = document.createElement('div');
  grid.className = 'card-grid';

  grid.appendChild(newCard('Новый предмет', async () => {
    const name = await askText('Название предмета');
    if (!name) return;
    const created = await window.lectureApp.createSubject(name);
    await window.lectureApp.setCurrentSubject(created);
    openSubjectGrid();
  }));

  for (const subject of subjects) {
    const lectures = await window.lectureApp.listLectures(subject);
    grid.appendChild(
      subjectCard(subject, lectures.length, () => openSubject(subject), {
        onRename: async () => {
          const newName = await askText('Новое название предмета', subject);
          if (!newName || newName === subject) return;
          await window.lectureApp.renameSubject(subject, newName);
          openSubjectGrid();
        },
        onDelete: async () => {
          const ok = await askConfirm('Удалить предмет?', `«${subject}» вместе со всеми лекциями внутри будет удалён без возможности восстановления.`);
          if (!ok) return;
          await window.lectureApp.deleteSubject(subject);
          openSubjectGrid();
        },
      })
    );
  }

  wrapper.appendChild(grid);
  setContent(wrapper);
}

async function openSubject(subject) {
  libraryState.view = 'subject';
  libraryState.subject = subject;
  searchInput.value = '';
  libTitle.textContent = subject;
  libBackBtn.style.display = 'flex';
  libBackBtn.onclick = openSubjectGrid;
  const chatBtn = document.getElementById('lib-chat-btn');
  chatBtn.style.display = 'inline-flex';
  chatBtn.innerHTML = `${icon('chat', 14)}<span>Чат по предмету</span>`;
  chatBtn.onclick = () => openChat({ subject, folderName: null }, subject);

  const lectures = await window.lectureApp.listLectures(subject);

  const grid = document.createElement('div');
  grid.className = 'card-grid';

  grid.appendChild(newCard('Новая лекция', async () => {
    const title = await askText('Название лекции');
    if (!title) return;
    const meta = await window.lectureApp.createLecture(subject, title);
    openRecordingView(subject, meta);
  }));

  for (const lecture of lectures) {
    grid.appendChild(lectureCard(lecture, subject, () => openNote(subject, lecture, 'subject')));
  }
  setContent(grid);
}

async function openNote(subject, lecture, backTo) {
  libraryState.view = 'note';
  libTitle.textContent = lecture.title;
  libBackBtn.style.display = 'flex';
  libBackBtn.onclick = () => (backTo === 'search' ? renderSearchResults() : openSubject(subject));
  const chatBtn = document.getElementById('lib-chat-btn');
  chatBtn.style.display = 'inline-flex';
  chatBtn.innerHTML = `${icon('chat', 14)}<span>Чат по лекции</span>`;
  chatBtn.onclick = () => openChat({ subject, folderName: lecture.folderName }, lecture.title);

  let markdown = await window.lectureApp.loadLecture(subject, lecture.folderName);
  const raw = await window.lectureApp.loadLectureRaw(subject, lecture.folderName);
  const hasRaw = Boolean(raw && (raw.transcript.length > 0 || raw.slides.length > 0));
  let showingOriginal = false;

  const dateStr = new Date(lecture.date).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const durationStr = lecture.durationSec > 0 ? ` · ${Math.round(lecture.durationSec / 60)} мин` : '';

  function renderOriginalHtml() {
    const lines = raw.transcript.map((s) => `<div class="transcript-line"><span class="ts">[${formatTimestamp(s.startSec)}]</span>${escapeHtml(s.text)}</div>`);
    return lines.join('') || '<p class="hint">Расшифровка речи пуста.</p>';
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'note-view';
  wrapper.innerHTML = `
    <div class="note-view-head">
      <span class="note-meta">${dateStr}${durationStr}</span>
      <div class="toolbar-spacer"></div>
      ${hasRaw ? `<button class="ghost-btn" id="note-rebuild-btn">${icon('file', 14)}<span>Пересобрать конспект</span></button>` : ''}
      ${hasRaw ? `<button class="ghost-btn" id="note-original-btn">${icon('mic', 14)}<span>Что записалось</span></button>` : ''}
      <button class="ghost-btn" id="note-quiz-btn">${icon('help', 14)}<span>Проверь себя</span></button>
      <button class="ghost-btn" id="note-record-btn">${icon('mic', 14)}<span>Записать ещё</span></button>
      <button class="ghost-btn" id="note-edit-btn">${icon('pencil', 14)}<span>Изменить</span></button>
      <button class="ghost-btn" id="note-copy-btn">${icon('copy', 14)}<span>Копировать</span></button>
    </div>
    <div class="notes scroll-box" id="note-render">${renderMarkdown(markdown) || '<p class="hint">Пока пусто.</p>'}</div>
    <textarea id="note-editor" class="note-editor" style="display:none"></textarea>
    <div class="modal-actions" id="note-edit-actions" style="display:none">
      <button class="ghost-btn" id="note-cancel-btn">Отмена</button>
      <button class="primary-btn" id="note-save-btn">Сохранить</button>
    </div>
  `;
  setContent(wrapper);
  wrapper.querySelector('#note-copy-btn').addEventListener('click', () => window.lectureApp.copyNotes(markdown));
  wrapper.querySelector('#note-record-btn').addEventListener('click', () => openRecordingView(subject, lecture));

  const renderEl = wrapper.querySelector('#note-render');
  const editorEl = wrapper.querySelector('#note-editor');
  const editActionsEl = wrapper.querySelector('#note-edit-actions');
  const editBtn = wrapper.querySelector('#note-edit-btn');
  const rebuildBtn = wrapper.querySelector('#note-rebuild-btn');
  const originalBtn = wrapper.querySelector('#note-original-btn');
  const quizBtn = wrapper.querySelector('#note-quiz-btn');
  editorEl.value = markdown;

  let showingQuiz = false;
  let quizText = null;

  function setEditing(editing) {
    renderEl.style.display = editing ? 'none' : 'block';
    editBtn.style.display = editing ? 'none' : 'inline-flex';
    editorEl.style.display = editing ? 'block' : 'none';
    editActionsEl.style.display = editing ? 'flex' : 'none';
    if (rebuildBtn) rebuildBtn.style.display = editing ? 'none' : 'inline-flex';
    if (originalBtn) originalBtn.style.display = editing ? 'none' : 'inline-flex';
    quizBtn.style.display = editing ? 'none' : 'inline-flex';
  }

  function showNotes() {
    showingOriginal = false;
    showingQuiz = false;
    renderEl.innerHTML = renderMarkdown(markdown) || '<p class="hint">Пока пусто.</p>';
    if (originalBtn) originalBtn.innerHTML = `${icon('mic', 14)}<span>Что записалось</span>`;
    quizBtn.innerHTML = `${icon('help', 14)}<span>Проверь себя</span>`;
  }

  function showOriginal() {
    showingOriginal = true;
    showingQuiz = false;
    renderEl.innerHTML = renderOriginalHtml();
    if (originalBtn) originalBtn.innerHTML = `${icon('file', 14)}<span>Показать конспект</span>`;
    quizBtn.innerHTML = `${icon('help', 14)}<span>Проверь себя</span>`;
  }

  async function showQuiz() {
    if (showingQuiz) {
      showNotes();
      return;
    }
    showingOriginal = false;
    showingQuiz = true;
    if (originalBtn) originalBtn.innerHTML = `${icon('mic', 14)}<span>Что записалось</span>`;
    if (quizText !== null) {
      renderEl.innerHTML = renderMarkdown(quizText);
      quizBtn.innerHTML = `${icon('file', 14)}<span>К конспекту</span>`;
      return;
    }
    const original = quizBtn.innerHTML;
    quizBtn.disabled = true;
    quizBtn.innerHTML = `${rubyGemSvg(14)}<span>Готовлю тест…</span>`;
    renderEl.innerHTML = `<p class="hint">Готовлю вопросы по конспекту…</p>`;
    try {
      quizText = await window.lectureApp.generateQuiz(subject, lecture.folderName);
      renderEl.innerHTML = renderMarkdown(quizText);
      quizBtn.innerHTML = `${icon('file', 14)}<span>К конспекту</span>`;
    } catch (err) {
      showingQuiz = false;
      renderEl.innerHTML = `<p class="hint" style="color:var(--danger)">Не удалось собрать тест: ${escapeHtml(String(err.message || err))}</p>`;
      quizBtn.innerHTML = original;
    } finally {
      quizBtn.disabled = false;
    }
  }

  quizBtn.addEventListener('click', showQuiz);

  async function rebuildNotes() {
    if (!rebuildBtn) return;
    const original = rebuildBtn.innerHTML;
    rebuildBtn.disabled = true;
    rebuildBtn.innerHTML = `${rubyGemSvg(14)}<span>Собираю конспект…</span>`;
    try {
      markdown = await window.lectureApp.rebuildLectureNotes(subject, lecture.folderName);
      editorEl.value = markdown;
      lecture.notesFailed = false;
      quizText = null; // stale now that the underlying notes changed
      if (!showingOriginal && !showingQuiz) showNotes();
    } catch (err) {
      if (!showingOriginal && !showingQuiz) {
        const raw = String(err.message || err);
        const message = /503|UNAVAILABLE|overloaded|высок(?:ий|ая) спрос/i.test(raw)
          ? 'Gemini сейчас перегружен — это временно. Попробуй пересобрать ещё раз через минуту.'
          : `Не удалось собрать конспект: ${raw}`;
        renderEl.innerHTML = `<p class="hint" style="color:var(--danger)">${escapeHtml(message)}</p>`;
      }
    } finally {
      rebuildBtn.disabled = false;
      rebuildBtn.innerHTML = original;
    }
  }

  if (rebuildBtn) rebuildBtn.addEventListener('click', rebuildNotes);
  if (originalBtn) {
    originalBtn.addEventListener('click', () => (showingOriginal ? showNotes() : showOriginal()));
  }

  editBtn.addEventListener('click', () => {
    setEditing(true);
    editorEl.focus();
  });

  wrapper.querySelector('#note-cancel-btn').addEventListener('click', () => {
    editorEl.value = markdown;
    setEditing(false);
  });

  wrapper.querySelector('#note-save-btn').addEventListener('click', async () => {
    markdown = editorEl.value;
    await window.lectureApp.saveLectureMarkdown(subject, lecture.folderName, markdown);
    showNotes();
    setEditing(false);
  });

  // The recording finished but the conspect-building call failed at the time
  // (rate limit, timeout) - don't leave the raw-transcript dump as if it were
  // the final result, retry automatically since the original material is
  // right here on disk.
  if (lecture.notesFailed && hasRaw) {
    void rebuildNotes();
  }
}

async function renderSearchResults() {
  libraryState.view = 'search';
  libTitle.textContent = 'Результаты поиска';
  libBackBtn.style.display = 'none';
  document.getElementById('lib-chat-btn').style.display = 'none';

  const { subjects, lectures } = await window.lectureApp.searchLectures(searchInput.value.trim());
  if (subjects.length === 0 && lectures.length === 0) {
    setContent(emptyState('Ничего не найдено.'));
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  for (const subject of subjects) {
    const count = (await window.lectureApp.listLectures(subject)).length;
    grid.appendChild(
      subjectCard(subject, count, () => openSubject(subject), {
        onRename: async () => {
          const newName = await askText('Новое название предмета', subject);
          if (!newName || newName === subject) return;
          await window.lectureApp.renameSubject(subject, newName);
          renderSearchResults();
        },
        onDelete: async () => {
          const ok = await askConfirm('Удалить предмет?', `«${subject}» вместе со всеми лекциями внутри будет удалён без возможности восстановления.`);
          if (!ok) return;
          await window.lectureApp.deleteSubject(subject);
          renderSearchResults();
        },
      })
    );
  }
  for (const lecture of lectures) {
    grid.appendChild(lectureCard(lecture, lecture.subject, () => openNote(lecture.subject, lecture, 'search'), true));
  }
  setContent(grid);
}

function setContent(node) {
  libraryContent.innerHTML = '';
  libraryContent.appendChild(node);
}

function emptyState(text) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.textContent = text;
  return div;
}

function newCard(label, onClick) {
  const card = document.createElement('div');
  card.className = 'card card-new';
  card.innerHTML = `${icon('plus', 22)}<span>${escapeHtml(label)}</span>`;
  card.addEventListener('click', onClick);
  return card;
}

function subjectCard(subject, lectureCount, onClick, { onRename, onDelete }) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-tile ${tileClassFor(subject)}">${icon('folder', 18)}</div>
    <button class="card-menu-btn">${icon('more', 16)}</button>
    <div class="card-title">${escapeHtml(subject)}</div>
    <div class="card-meta">${lectureCount} ${pluralLectures(lectureCount)}</div>
  `;
  card.addEventListener('click', onClick);
  card.querySelector('.card-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: 'Переименовать', icon: 'pencil', onClick: onRename },
      { label: 'Удалить', icon: 'trash', danger: true, onClick: onDelete },
    ]);
  });
  return card;
}

function lectureCard(lecture, subject, onClick, showSubjectTag = false) {
  const date = new Date(lecture.date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-tile" style="background:var(--bg-active); color:var(--text-muted)">${icon('file', 18)}</div>
    <button class="card-menu-btn">${icon('more', 16)}</button>
    <div class="card-title">${escapeHtml(lecture.title)}</div>
    ${showSubjectTag ? `<div class="search-tag">${escapeHtml(subject)}</div>` : ''}
    <div class="card-meta">${date} · ${Math.round(lecture.durationSec / 60)} мин</div>
  `;
  card.addEventListener('click', () => onClick());
  card.querySelector('.card-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      {
        label: 'Переименовать',
        icon: 'pencil',
        onClick: async () => {
          const newTitle = await askText('Новое название лекции', lecture.title);
          if (!newTitle || newTitle === lecture.title) return;
          await window.lectureApp.renameLecture(subject, lecture.folderName, newTitle);
          libraryState.view === 'search' ? renderSearchResults() : openSubject(subject);
        },
      },
      {
        label: 'Удалить',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          const ok = await askConfirm('Удалить лекцию?', `«${lecture.title}» будет удалена без возможности восстановления.`);
          if (!ok) return;
          await window.lectureApp.deleteLecture(subject, lecture.folderName);
          libraryState.view === 'search' ? renderSearchResults() : openSubject(subject);
        },
      },
    ]);
  });
  return card;
}

function pluralForm(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return few;
  return many;
}

function pluralLectures(n) {
  return pluralForm(n, 'лекция', 'лекции', 'лекций');
}

// --- Chat with AI, grounded in one subject's or one lecture's saved notes ---
let chatScope = null; // { subject, folderName: string|null }
let chatHistory = []; // { role: 'user'|'model', text }

document.getElementById('chat-back-btn').innerHTML = icon('chevronLeft', 18);
document.getElementById('chat-back-btn').addEventListener('click', () => {
  switchToTab('history');
  if (chatScope) openSubject(chatScope.subject);
  else openSubjectGrid();
});

function openChat(scope, titleLabel) {
  chatScope = scope;
  chatHistory = [];
  document.getElementById('chat-title').textContent = scope ? `Чат: ${titleLabel}` : 'Чат с ИИ';
  document.getElementById('chat-back-btn').style.display = scope ? '' : 'none';
  document.getElementById('chat-messages').innerHTML = scope
    ? '<p class="hint">Спрашивай по конспекту, проси объяснить термин, составить вопросы для самопроверки и т.п.</p>'
    : '<p class="hint">Спроси про любой предмет — например «какое дз по математике» — я сам найду нужный конспект.</p>';
  switchToTab('chat');
  document.getElementById('chat-input').focus();
}

function appendChatBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-bubble-${role}`;
  bubble.innerHTML = renderMarkdown(text) || escapeHtml(text);
  document.getElementById('chat-messages').appendChild(bubble);
  document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;
  return bubble;
}

// Reply text streams in over IPC_CHAT_STREAM_DELTA as Gemini generates it -
// only one chat send is ever in flight at a time (the send button is
// disabled meanwhile), so a single "current bubble" is enough bookkeeping.
let streamingBubble = null;
let streamingText = '';
window.lectureApp.onChatStreamDelta((delta) => {
  if (!streamingBubble) return;
  streamingText += delta;
  streamingBubble.innerHTML = renderMarkdown(streamingText) || escapeHtml(streamingText);
  const messagesEl = document.getElementById('chat-messages');
  messagesEl.scrollTop = messagesEl.scrollHeight;
});

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';

  appendChatBubble('user', message);
  const thinkingBubble = appendChatBubble('model', '');
  thinkingBubble.innerHTML = `<div class="thinking-row">${rubyGemSvg(16)}<span class="thinking-label">Ruby думает…</span></div>`;

  const sendBtn = document.getElementById('chat-send-btn');
  sendBtn.disabled = true;
  streamingBubble = thinkingBubble;
  streamingText = '';
  try {
    const scope = chatScope || { subject: null, folderName: null };
    const reply = await window.lectureApp.chatSend(scope, chatHistory, message);
    chatHistory.push({ role: 'user', text: message }, { role: 'model', text: reply });
    thinkingBubble.innerHTML = renderMarkdown(reply) || escapeHtml(reply);
  } catch (err) {
    thinkingBubble.innerHTML = '<p class="hint" style="color:var(--danger)">Не удалось получить ответ. Попробуй ещё раз.</p>';
  } finally {
    streamingBubble = null;
    sendBtn.disabled = false;
  }
}

document.getElementById('chat-send-btn').addEventListener('click', sendChatMessage);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

// --- Settings tab ---
const settingsForm = document.getElementById('settings-form');
const settingsSaved = document.getElementById('settings-saved');
const apiKeyInput = document.getElementById('api-key-input');
const apiKeyStatus = document.getElementById('api-key-status');
const libraryPathInput = document.getElementById('library-path-input');

async function checkApiStatus() {
  const { configured } = await window.lectureApp.getApiStatus();
  document.getElementById('api-key-banner').style.display = configured ? 'none' : 'block';
  apiKeyStatus.textContent = configured ? 'Ключ сохранён и готов к работе.' : 'Ключ ещё не задан.';
  apiKeyStatus.className = configured ? 'hint success' : 'hint';
  return configured;
}

document.getElementById('save-api-key-btn').addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  await window.lectureApp.saveApiKey(key);
  apiKeyInput.value = '';
  checkApiStatus();
});

const groqKeyInput = document.getElementById('groq-key-input');
const groqKeyStatus = document.getElementById('groq-key-status');

async function checkGroqApiStatus() {
  const { configured } = await window.lectureApp.getGroqApiStatus();
  groqKeyStatus.textContent = configured
    ? 'Ключ сохранён — транскрипция идёт через Groq.'
    : 'Ключ не задан — транскрипция идёт через Gemini, как обычно.';
  groqKeyStatus.className = configured ? 'hint success' : 'hint';
}

document.getElementById('save-groq-key-btn').addEventListener('click', async () => {
  const key = groqKeyInput.value.trim();
  if (!key) return;
  await window.lectureApp.saveGroqApiKey(key);
  groqKeyInput.value = '';
  checkGroqApiStatus();
});

document.getElementById('clear-groq-key-btn').addEventListener('click', async () => {
  await window.lectureApp.clearGroqApiKey();
  checkGroqApiStatus();
});

document.getElementById('choose-folder-btn').addEventListener('click', async () => {
  const chosen = await window.lectureApp.chooseLibraryFolder();
  if (chosen) libraryPathInput.value = chosen;
});

document.getElementById('reveal-folder-btn').addEventListener('click', () => {
  window.lectureApp.revealLibraryFolder();
});

async function loadSettingsIntoForm() {
  const settings = await window.lectureApp.getSettings();
  for (const [key, value] of Object.entries(settings)) {
    const field = settingsForm.elements.namedItem(key);
    if (field) field.value = value;
  }
  libraryPathInput.value = settings.libraryPath;
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(settingsForm);
  const current = await window.lectureApp.getSettings();
  const settings = {
    ...current,
    slideIntervalSec: Number(formData.get('slideIntervalSec')),
    toggleHotkey: formData.get('toggleHotkey'),
    callOutName: formData.get('callOutName').trim(),
    markerPhrase: formData.get('markerPhrase').trim(),
  };
  await window.lectureApp.saveSettings(settings);
  settingsSaved.textContent = 'Сохранено. Хоткей применится после перезапуска приложения.';
  settingsSaved.className = 'hint success';
  setTimeout(() => (settingsSaved.textContent = ''), 4000);
});

// --- Onboarding: a short branded welcome plays on every launch, then either
// asks for an API key (first run) or fades straight into the app. ---
const onboarding = document.getElementById('onboarding');
let welcomeAutoAdvanceTimer = null;
let apiKeyAlreadyConfigured = false;

function showOnboardingStep(name) {
  document.querySelectorAll('.onboarding-step').forEach((el) => {
    el.classList.toggle('active', el.dataset.step === name);
  });
}

function proceedFromWelcome() {
  clearTimeout(welcomeAutoAdvanceTimer);
  if (apiKeyAlreadyConfigured) {
    dismissOnboarding();
  } else {
    showOnboardingStep('api-key');
  }
}

document.getElementById('welcome-next-btn').addEventListener('click', proceedFromWelcome);

document.querySelector('.onboarding-skip').addEventListener('click', () => dismissOnboarding());

document.getElementById('onboarding-save-btn').addEventListener('click', async () => {
  const key = document.getElementById('onboarding-key-input').value.trim();
  const errorEl = document.getElementById('onboarding-error');
  if (!key) {
    errorEl.textContent = 'Вставь ключ или нажми «Пропустить».';
    return;
  }
  errorEl.textContent = '';
  await window.lectureApp.saveApiKey(key);
  checkApiStatus();
  showOnboardingStep('done');
  setTimeout(() => dismissOnboarding(), 1100);
});

function dismissOnboarding() {
  onboarding.classList.add('fade-out');
  setTimeout(() => onboarding.classList.add('hidden'), 500);
}

async function initOnboarding() {
  apiKeyAlreadyConfigured = await checkApiStatus();
  checkGroqApiStatus();
  showOnboardingStep('welcome');
  welcomeAutoAdvanceTimer = setTimeout(proceedFromWelcome, 1700);
}

loadSettingsIntoForm();
openChat(null, 'Все предметы');
initOnboarding();
