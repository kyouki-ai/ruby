// Plain-JS renderer logic. Runs in the isolated renderer context; the only
// bridge to the main process is `window.lectureApp`, exposed by preload.ts.
// `icon()` / `ICONS` come from icons.js, `t()`/`getLang()`/`setLang()` from
// i18n.js, both loaded before this file.
applyStaticTranslations();

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
  modalCancelBtn.style.display = '';
  modalOkBtn.textContent = t('common.ok');
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
  modalCancelBtn.style.display = '';
  modalOkBtn.textContent = t('common.delete');
  modalOkBtn.onclick = () => closeModal(true);
  modalOverlay.style.display = 'flex';
  return new Promise((resolve) => { modalOverlay._resolve = (v) => resolve(Boolean(v)); });
}

/** Single-button informational modal (an error, a heads-up) - no cancel, since there's nothing to cancel. */
function showAlert(title, message) {
  modalTitle.textContent = title;
  modalMessage.textContent = message;
  modalMessage.style.display = 'block';
  modalInput.style.display = 'none';
  modalCancelBtn.style.display = 'none';
  modalOkBtn.textContent = t('common.ok');
  modalOkBtn.onclick = () => closeModal(true);
  modalOverlay.style.display = 'flex';
  return new Promise((resolve) => { modalOverlay._resolve = () => resolve(); });
}

// --- Photo lightbox: a plain full-size preview for a lecture's attached
// photos (see openNote's "note.photos" section). ---
const photoLightboxOverlay = document.getElementById('photo-lightbox-overlay');
const photoLightboxImg = document.getElementById('photo-lightbox-img');
document.getElementById('photo-lightbox-close-btn').innerHTML = icon('winClose', 18);
function openPhotoLightbox(dataUrl) {
  photoLightboxImg.src = dataUrl;
  photoLightboxOverlay.style.display = 'flex';
}
function closePhotoLightbox() {
  photoLightboxOverlay.style.display = 'none';
  photoLightboxImg.src = '';
}
document.getElementById('photo-lightbox-close-btn').addEventListener('click', closePhotoLightbox);
photoLightboxOverlay.addEventListener('click', (e) => {
  if (e.target === photoLightboxOverlay) closePhotoLightbox();
});

/** Renders a LaTeX expression via KaTeX (loaded globally from vendor/katex),
 * falling back to plain escaped text if katex isn't available or the
 * expression is malformed - a broken formula should never break the whole
 * render. throwOnError:false already covers most malformed input on its
 * own (KaTeX renders a red error span instead of throwing). */
function renderMath(expr, displayMode) {
  try {
    if (typeof katex === 'undefined') return escapeHtml(expr);
    return katex.renderToString(expr, { throwOnError: false, displayMode });
  } catch {
    return escapeHtml(expr);
  }
}

/** Tiny markdown -> HTML renderer covering just what notesBuilder.ts produces.
 * Headings get a stable `note-heading-N` id (N = its position among headings,
 * in document order) so the note view's outline panel can scroll straight to
 * one by index - harmless for the other places this renders (chat replies).
 * "$$...$$" display-math blocks are pulled out before line-splitting (they
 * can span multiple lines) and swapped back in as rendered KaTeX afterward;
 * inline "$...$" math is handled the same way inside inlineMarkdown. */
function renderMarkdown(markdown) {
  const mathBlocks = [];
  const withPlaceholders = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (_m, expr) => {
    const token = `@@MATH_BLOCK_${mathBlocks.length}@@`;
    mathBlocks.push(renderMath(expr.trim(), true));
    return token;
  });

  const lines = withPlaceholders.split('\n');
  let html = '';
  let inList = false;
  let headingIndex = 0;

  const closeList = () => {
    if (inList) { html += '</ul>'; inList = false; }
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)/.exec(line);
    const bullet = /^[-*]\s+(.*)/.exec(line);

    if (heading) {
      closeList();
      const level = heading[1].length + 1; // ## -> h3
      html += `<h${level} id="note-heading-${headingIndex++}">${inlineMarkdown(heading[2])}</h${level}>`;
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

  mathBlocks.forEach((rendered, i) => {
    html = html.split(`@@MATH_BLOCK_${i}@@`).join(rendered);
  });
  return html;
}

/** Same heading scan/indexing as renderMarkdown, kept separate so the note
 * view's outline panel can list them without re-parsing the rendered HTML. */
function extractHeadings(markdown) {
  const headings = [];
  let idx = 0;
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,3})\s+(.*)/.exec(line);
    if (m) {
      headings.push({ id: `note-heading-${idx}`, level: m[1].length, text: m[2].trim().replace(/^⭐\s*/, '') });
      idx++;
    }
  }
  return headings;
}

function inlineMarkdown(text) {
  // Math extracted (and rendered) before escaping, then spliced back in
  // after - escaping first would mangle LaTeX like "$a < b$" into HTML
  // entities before KaTeX ever saw the real "<".
  const mathTokens = [];
  const withPlaceholders = text.replace(/\$([^$\n]+?)\$/g, (_m, expr) => {
    const token = `@@MATH_INLINE_${mathTokens.length}@@`;
    mathTokens.push(renderMath(expr.trim(), false));
    return token;
  });
  let html = escapeHtml(withPlaceholders).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  mathTokens.forEach((rendered, i) => {
    html = html.split(`@@MATH_INLINE_${i}@@`).join(rendered);
  });
  return html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** The text handed to another AI when copying a detected assignment - the
 * slide image itself rides along separately via clipboard.write({text,image}). */
function buildAssignmentPrompt(entry) {
  let prompt = t('assignments.promptIntro', { text: entry.text.trim() });
  if (entry.slideText) prompt += `\n\n${t('assignments.promptSlideText')}\n${entry.slideText}`;
  if (entry.slideScreenshotBase64) prompt += `\n\n${t('assignments.promptHasImage')}`;
  prompt += `\n\n${t('assignments.promptAsk')}`;
  return prompt;
}

function assignmentRow(entry) {
  const row = document.createElement('div');
  row.className = 'assignment-row';
  row.innerHTML = `
    <div class="assignment-text">
      [${formatTimestamp(entry.offsetSec)}] ${escapeHtml(entry.text.trim())}
      ${entry.slideScreenshotBase64 ? `<div class="assignment-slide-hint">${escapeHtml(t('assignments.slideHint'))}</div>` : ''}
    </div>
    <button class="ghost-btn assignment-copy-btn">${icon('copy', 13)}<span>${escapeHtml(t('assignments.copy'))}</span></button>
  `;
  const btn = row.querySelector('.assignment-copy-btn');
  btn.addEventListener('click', async () => {
    await window.lectureApp.copyAssignmentPrompt(buildAssignmentPrompt(entry), entry.slideScreenshotBase64 || null);
    const original = btn.innerHTML;
    btn.innerHTML = `${icon('copy', 13)}<span>${escapeHtml(t('assignments.copied'))}</span>`;
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  });
  return row;
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

// --- Find bar (Ctrl+F) - a custom BrowserWindow has no built-in one, so this
// is a thin UI over Electron's own webContents.findInPage (see main.ts). ---
const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const findCountEl = document.getElementById('find-count');

document.getElementById('find-icon').innerHTML = icon('search', 14);
document.getElementById('find-prev-btn').innerHTML = icon('chevronLeft', 16);
document.getElementById('find-next-btn').innerHTML = `<span style="display:inline-block; transform:scaleX(-1)">${icon('chevronLeft', 16)}</span>`;
document.getElementById('find-close-btn').innerHTML = icon('winClose', 14);

function openFindBar() {
  findBar.style.display = 'flex';
  findInput.focus();
  findInput.select();
}

function closeFindBar() {
  findBar.style.display = 'none';
  findInput.value = '';
  findCountEl.textContent = '';
  window.lectureApp.stopFindInPage();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    openFindBar();
  } else if (e.key === 'Escape' && findBar.style.display !== 'none') {
    closeFindBar();
  }
});

findInput.addEventListener('input', () => {
  const text = findInput.value;
  if (!text) {
    window.lectureApp.stopFindInPage();
    findCountEl.textContent = '';
    return;
  }
  window.lectureApp.findInPage(text, true, false);
});
findInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !findInput.value) return;
  window.lectureApp.findInPage(findInput.value, !e.shiftKey, true);
});
document.getElementById('find-prev-btn').addEventListener('click', () => {
  if (findInput.value) window.lectureApp.findInPage(findInput.value, false, true);
});
document.getElementById('find-next-btn').addEventListener('click', () => {
  if (findInput.value) window.lectureApp.findInPage(findInput.value, true, true);
});
document.getElementById('find-close-btn').addEventListener('click', closeFindBar);

window.lectureApp.onFoundInPage(({ activeMatchOrdinal, matches }) => {
  findCountEl.textContent = matches > 0 ? `${activeMatchOrdinal}/${matches}` : '0/0';
});

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
document.getElementById('copy-btn').innerHTML = `${icon('copy', 15)}<span>${escapeHtml(t('note.copy'))}</span>`;
document.getElementById('lib-back-btn').innerHTML = icon('chevronLeft', 18);
document.getElementById('search-icon').innerHTML = icon('search', 16);

// The search box lives behind a topbar icon button instead of a permanent
// input - a fixed-width text box never fit cleanly next to the nav tabs at
// smaller window sizes, an icon does.
const searchToggleBtn = document.getElementById('search-toggle-btn');
const searchPopover = document.getElementById('search-popover');
searchToggleBtn.innerHTML = icon('search', 17);
searchToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const opening = searchPopover.style.display === 'none';
  searchPopover.style.display = opening ? 'flex' : 'none';
  if (opening) setTimeout(() => searchInput.focus(), 0);
});
document.addEventListener('click', (e) => {
  if (searchPopover.style.display !== 'none' && e.target !== searchToggleBtn && !searchPopover.contains(e.target)) {
    searchPopover.style.display = 'none';
  }
});

document.getElementById('copy-chrome-url-btn').addEventListener('click', (e) => {
  window.lectureApp.copyText('chrome://extensions');
  const original = e.currentTarget.textContent;
  e.currentTarget.textContent = t('assignments.copied');
  setTimeout(() => (e.currentTarget.textContent = original), 1500);
});

document.getElementById('open-extension-folder-btn').addEventListener('click', () => {
  window.lectureApp.openExtensionFolder();
});

// --- Views: the app opens straight into the AI chat (no folder to pick
// first) - "Мои предметы" is one toggle away for browsing/recording.
// Settings is a modal overlay on top of whichever mode was active, not a
// tab of its own, so there's nothing for it to navigate back to. ---
function switchToTab(tabName) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tabName}`));
  // The chat/library/calendar toggle only reflects those three modes - the
  // recording screen is reached "on top" of whichever mode was active.
  if (tabName === 'chat' || tabName === 'history' || tabName === 'calendar') {
    document.getElementById('mode-chat-btn').classList.toggle('active', tabName === 'chat');
    document.getElementById('mode-library-btn').classList.toggle('active', tabName === 'history');
    document.getElementById('mode-calendar-btn').classList.toggle('active', tabName === 'calendar');
  }
}

document.getElementById('mode-chat-btn').addEventListener('click', () => {
  if (currentThreadId) switchToTab('chat');
  else initChat();
});
document.getElementById('mode-library-btn').addEventListener('click', () => {
  switchToTab('history');
  openSubjectGrid();
});
document.getElementById('mode-calendar-btn').addEventListener('click', () => {
  switchToTab('calendar');
  openCalendar();
});

document.getElementById('settings-btn').innerHTML = icon('gear', 17);
document.getElementById('settings-close-btn').innerHTML = icon('winClose', 15);
function openSettingsModal() {
  document.getElementById('settings-modal-overlay').style.display = 'flex';
}
function closeSettingsModal() {
  document.getElementById('settings-modal-overlay').style.display = 'none';
}
document.getElementById('settings-btn').addEventListener('click', openSettingsModal);
document.getElementById('settings-close-btn').addEventListener('click', closeSettingsModal);
document.getElementById('settings-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal-overlay') closeSettingsModal();
});

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
  if (liveBackAction) liveBackAction();
  else openSubjectGrid();
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
    ? `<p class="hint">${rubyGemSvg(13)} ${escapeHtml(t('live.finalizing', { sec: FINALIZE_ESTIMATE_SEC, left: secondsLeft }))}</p>`
    : `<p class="hint">${rubyGemSvg(13)} ${escapeHtml(t('live.finalizingLong'))}</p>`;
}

function startFinalizingCountdown() {
  stopFinalizingCountdown();
  document.getElementById('live-notes-panel').style.display = '';
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
  liveAssignments = [];
  renderLiveAssignments();
  document.getElementById('silence-warning').style.display = 'none';
  // The structured conspect is only built once, when recording stops (see
  // main.ts) - rebuilding it continuously would burn through Gemini's free
  // daily quota well before a full day of lectures is over. Showing an
  // empty "will appear after you stop" panel for the entire recording was
  // just dead space - hide it and let the transcript use the full width
  // until there's actually something to show (see startFinalizingCountdown).
  document.getElementById('live-notes-panel').style.display = 'none';
  notesBox.innerHTML = '';
});

// --- Live assignment/homework detection (see assignments/assignmentDetector.ts) ---
let liveAssignments = [];

function renderLiveAssignments() {
  const panel = document.getElementById('live-assignments');
  const listEl = document.getElementById('live-assignments-list');
  if (liveAssignments.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  listEl.innerHTML = '';
  for (const entry of liveAssignments) listEl.appendChild(assignmentRow(entry));
}

window.lectureApp.onAssignmentDetected((entry) => {
  liveAssignments.push(entry);
  renderLiveAssignments();
});

// --- Auto-stop-on-silence warning (opt-in, see Settings) - main.ts only
// ever asks the renderer to stop; the renderer decides how, by reusing the
// exact same button click a manual stop would use. ---
document.getElementById('silence-warning-dismiss-btn').addEventListener('click', () => {
  window.lectureApp.dismissSilenceWarning();
  document.getElementById('silence-warning').style.display = 'none';
});

window.lectureApp.onSilenceWarning(({ autoStopInSec }) => {
  const banner = document.getElementById('silence-warning');
  const textEl = document.getElementById('silence-warning-text');
  const dismissBtn = document.getElementById('silence-warning-dismiss-btn');

  if (autoStopInSec <= 0) {
    textEl.textContent = t('live.silenceAutoStopped');
    dismissBtn.style.display = 'none';
    banner.style.display = 'flex';
    const stopBtn = document.getElementById('stop-mic-btn');
    if (stopBtn.style.display !== 'none' && !stopBtn.disabled) stopBtn.click();
    return;
  }

  dismissBtn.style.display = '';
  textEl.textContent = t('live.silenceWarning', { minutes: Math.ceil(autoStopInSec / 60) });
  banner.style.display = 'flex';
});

window.lectureApp.onSilenceWarningCleared(() => {
  document.getElementById('silence-warning').style.display = 'none';
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
    micErrorEl.textContent = t('live.micError');
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

document.getElementById('start-mic-btn').innerHTML = `${icon('mic', 16)}<span>${escapeHtml(t('live.startMic'))}</span>`;
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
    errorEl.textContent = t('live.extensionDisconnected');
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
  btn.textContent = t('note.rebuilding');
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

document.getElementById('attach-slide-btn').innerHTML = `${icon('file', 15)}<span>${escapeHtml(t('live.attachSlideFile'))}</span>`;
document.getElementById('attach-slide-btn').addEventListener('click', async () => {
  const btn = document.getElementById('attach-slide-btn');
  const original = btn.innerHTML;
  btn.innerHTML = `${icon('file', 15)}<span>${escapeHtml(t('live.attachingSlideFile'))}</span>`;
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
  // The panel starts hidden while recording (nothing to show yet - see
  // onConnectionStatus below), but now that notes are actually built
  // incrementally throughout the recording, not just once at the end, show
  // it the moment real content exists instead of waiting for the stop.
  if (markdown) document.getElementById('live-notes-panel').style.display = '';
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
  // A remote/extension-started recording never goes through
  // openRecordingView (there's no pre-picked lecture to set a backAction
  // for), so liveBackAction was still null once the recording actually
  // finished - the back button fell through to the subjects grid instead of
  // the lecture that was just made. Now that it exists, send it there.
  liveBackAction = () => openNote(meta.subject, meta, 'subject');
});

document.getElementById('copy-btn').addEventListener('click', () => {
  window.lectureApp.copyNotes(notesBox.dataset.raw || '');
});

// --- Recording screen: reached from a specific lecture inside a subject,
// not a permanent tab. `meta` is null for a brand-new lecture (created only
// once the recording actually finishes and gets saved).
let recordingTargetSubject = null;

// Where the live-back-btn returns to - defaults to the subjects grid, but
// e.g. "Записать ещё" from an existing lecture's note wants back to go to
// that exact note, not all the way up to the top.
let liveBackAction = null;

async function openRecordingView(subject, meta, returnTo) {
  recordingTargetSubject = subject;
  await window.lectureApp.setCurrentSubject(subject);
  await window.lectureApp.setRecordingTarget(meta ? meta.folderName : null);
  document.getElementById('live-target-label').textContent = meta ? `${subject} · ${meta.title}` : `${subject} · Новая лекция`;
  liveBackAction = returnTo || null;
  switchToTab('live');
}

// --- History tab: drill-down grid (subjects -> lectures -> note) ---
const libTitle = document.getElementById('lib-title');
const libBackBtn = document.getElementById('lib-back-btn');
const libraryContent = document.getElementById('library-content');
const searchInput = document.getElementById('search-input');

const libraryState = { view: 'grid', subject: null };

// The search box lives in the topbar now, not inside the library tab, so
// it's visible (and usable) from chat/calendar too - typing anywhere jumps
// to the library tab to show results, same as clicking a search hit always
// has.
searchInput.addEventListener('input', () => {
  if (searchInput.value.trim()) {
    switchToTab('history');
    renderSearchResults();
  } else if (libraryState.view === 'search') {
    openSubjectGrid();
  }
});

async function openSubjectGrid() {
  libraryState.view = 'grid';
  libraryState.subject = null;
  searchInput.value = '';
  libTitle.textContent = t('library.title');
  libBackBtn.style.display = 'none';
  document.getElementById('lib-chat-btn').style.display = 'none';
  document.getElementById('lib-export-btn').style.display = 'none';

  const reviewBtn = document.getElementById('lib-review-btn');
  const dueSummaries = await window.lectureApp.listDueFlashcards();
  const totalDue = dueSummaries.reduce((sum, s) => sum + s.dueCount, 0);
  if (totalDue > 0) {
    reviewBtn.style.display = 'inline-flex';
    reviewBtn.innerHTML = `${icon('cards', 14)}<span>${escapeHtml(t('flashcards.reviewButton', { count: totalDue }))}</span>`;
    reviewBtn.onclick = () => openGlobalFlashcardReview(dueSummaries);
  } else {
    reviewBtn.style.display = 'none';
  }

  const subjects = await window.lectureApp.listSubjects();
  const wrapper = document.createElement('div');

  const stats = await window.lectureApp.getLibraryStats();
  if (stats.lectureCount > 0) {
    const hours = stats.totalDurationSec / 3600;
    const hoursLabel = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
    const lastActivity = stats.lastActivityDate
      ? new Date(stats.lastActivityDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
      : '—';
    const streak = await window.lectureApp.getStudyStreak();
    const statsBar = document.createElement('div');
    statsBar.className = 'library-stats';
    statsBar.innerHTML = `
      <div class="library-stat"><span class="library-stat-num">${stats.subjectCount}</span><span class="library-stat-label">${pluralForm(stats.subjectCount, 'предмет', 'предмета', 'предметов')}</span></div>
      <div class="library-stat"><span class="library-stat-num">${stats.lectureCount}</span><span class="library-stat-label">${pluralLectures(stats.lectureCount)} записано</span></div>
      <div class="library-stat"><span class="library-stat-num">${hoursLabel}</span><span class="library-stat-label">${pluralForm(Math.round(hours), 'час', 'часа', 'часов')} расшифровано</span></div>
      <div class="library-stat"><span class="library-stat-num">${lastActivity}</span><span class="library-stat-label">последняя запись</span></div>
      ${streak.currentStreak > 0 ? `<div class="library-stat"><span class="library-stat-num">${streak.currentStreak}</span><span class="library-stat-label">${pluralForm(streak.currentStreak, 'день подряд', 'дня подряд', 'дней подряд')} повторяешь карточки</span></div>` : ''}
    `;
    wrapper.appendChild(statsBar);
  }

  const grid = document.createElement('div');
  grid.className = 'card-grid';

  grid.appendChild(newCard(t('library.newSubject'), async () => {
    const name = await askText(t('library.newSubjectPrompt'));
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
          const newName = await askText(t('library.renameSubjectPrompt'), subject);
          if (!newName || newName === subject) return;
          await window.lectureApp.renameSubject(subject, newName);
          openSubjectGrid();
        },
        onDelete: async () => {
          const ok = await askConfirm(t('library.deleteSubjectTitle'), t('library.deleteSubjectMsg', { name: subject }));
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
  document.getElementById('lib-review-btn').style.display = 'none';
  const chatBtn = document.getElementById('lib-chat-btn');
  chatBtn.style.display = 'inline-flex';
  chatBtn.innerHTML = `${icon('chat', 14)}<span>${escapeHtml(t('library.chatBySubject'))}</span>`;
  chatBtn.onclick = async () => {
    const thread = await window.lectureApp.findOrCreateLectureThread(subject, null, t('chat.scopeSubjectTitle', { name: subject }));
    openChatThread(thread.id, { backAction: () => openSubject(subject) });
  };

  const exportBtn = document.getElementById('lib-export-btn');
  exportBtn.style.display = 'inline-flex';
  exportBtn.innerHTML = `${icon('download', 14)}<span>${escapeHtml(t('note.export'))}</span>`;
  exportBtn.onclick = (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: t('note.exportPdf'), icon: 'download', onClick: () => exportWholeSubject(subject, 'pdf') },
      { label: t('note.exportDoc'), icon: 'download', onClick: () => exportWholeSubject(subject, 'doc') },
    ]);
  };

  const lectures = await window.lectureApp.listLectures(subject);
  const subjectMeta = await window.lectureApp.getSubjectMeta(subject);

  setContent(renderGroupBoard(subject, subjectMeta, lectures));
}

/** Combines every lecture in a subject into one exported file - the same per-lecture export IPC, just with all their rendered HTML concatenated first. */
async function exportWholeSubject(subject, format) {
  const exportBtn = document.getElementById('lib-export-btn');
  const original = exportBtn.innerHTML;
  exportBtn.disabled = true;
  try {
    const lectures = await window.lectureApp.listLectures(subject);
    const sections = [];
    for (const lecture of [...lectures].reverse()) {
      const markdown = await window.lectureApp.loadLecture(subject, lecture.folderName);
      const date = new Date(lecture.date).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      sections.push(`<h1>${escapeHtml(lecture.title)}</h1><p><em>${escapeHtml(date)}</em></p>${renderMarkdown(markdown)}`);
    }
    await window.lectureApp.exportNote(subject, sections.join('<hr/>'), format);
  } finally {
    exportBtn.disabled = false;
    exportBtn.innerHTML = original;
  }
}

// Free-form drag-and-drop board: lectures live in user-named groups
// ("Лекция"/"Практика"/"Лабораторная"/anything else), plus a synthetic
// "ungrouped" column (groupId null) for cards not yet sorted into one.
let draggedLecture = null;

function computeOrderBetween(prevOrder, nextOrder) {
  if (prevOrder == null && nextOrder == null) return Date.now();
  if (prevOrder == null) return nextOrder - 1000;
  if (nextOrder == null) return prevOrder + 1000;
  return (prevOrder + nextOrder) / 2;
}

function renderGroupBoard(subject, subjectMeta, lectures) {
  const byGroup = new Map(); // groupId (or null) -> lectures[], sorted by .order
  byGroup.set(null, []);
  for (const group of subjectMeta.groups) byGroup.set(group.id, []);
  for (const lecture of lectures) {
    const key = lecture.groupId && byGroup.has(lecture.groupId) ? lecture.groupId : null;
    byGroup.get(key).push(lecture);
  }
  for (const list of byGroup.values()) list.sort((a, b) => a.order - b.order);

  const board = document.createElement('div');
  board.className = 'group-board';

  const columns = [...subjectMeta.groups.map((g) => ({ id: g.id, name: g.name })), { id: null, name: t('library.ungrouped') }];
  for (const { id, name } of columns) {
    board.appendChild(renderGroupColumn(subject, id, name, byGroup.get(id) || []));
  }

  const addGroupBtn = document.createElement('div');
  addGroupBtn.className = 'add-group-column';
  addGroupBtn.innerHTML = `${icon('plus', 18)}<span>${escapeHtml(t('library.addGroup'))}</span>`;
  addGroupBtn.addEventListener('click', async () => {
    const name = await askText(t('library.groupNamePrompt'));
    if (!name) return;
    await window.lectureApp.createLectureGroup(subject, name);
    openSubject(subject);
  });
  board.appendChild(addGroupBtn);

  return board;
}

let draggedGroupId = null;

function renderGroupColumn(subject, groupId, name, lecturesInGroup) {
  const column = document.createElement('div');
  column.className = 'group-column';
  column.dataset.groupId = groupId || '';

  const header = document.createElement('div');
  header.className = 'group-column-header';
  header.innerHTML = `
    <div class="group-column-title">${escapeHtml(name)}</div>
    <div class="group-column-actions">
      <button class="group-icon-btn" data-action="add" title="${escapeHtml(t('library.newLecture'))}">${icon('plus', 14)}</button>
      ${groupId ? `<button class="group-icon-btn" data-action="menu" title="${escapeHtml(t('library.rename'))}">${icon('more', 14)}</button>` : ''}
    </div>
  `;
  header.querySelector('[data-action="add"]').addEventListener('click', async () => {
    const title = await askText(t('library.newLecturePrompt'));
    if (!title) return;
    const meta = await window.lectureApp.createLecture(subject, title, groupId || undefined);
    openRecordingView(subject, meta, () => openSubject(subject));
  });
  const menuBtn = header.querySelector('[data-action="menu"]');
  if (menuBtn) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(e.currentTarget, [
        {
          label: t('library.rename'),
          icon: 'pencil',
          onClick: async () => {
            const newName = await askText(t('library.renameGroupPrompt'), name);
            if (!newName || newName === name) return;
            await window.lectureApp.renameLectureGroup(subject, groupId, newName);
            openSubject(subject);
          },
        },
        {
          label: t('library.delete'),
          icon: 'trash',
          danger: true,
          onClick: async () => {
            const ok = await askConfirm(t('library.deleteGroupTitle'), t('library.deleteGroupMsg', { name }));
            if (!ok) return;
            await window.lectureApp.deleteLectureGroup(subject, groupId);
            openSubject(subject);
          },
        },
      ]);
    });
  }
  if (groupId) {
    header.draggable = true;
    header.classList.add('group-column-header-draggable');
    header.addEventListener('dragstart', (e) => {
      draggedGroupId = groupId;
      e.stopPropagation();
    });
    header.addEventListener('dragend', () => {
      draggedGroupId = null;
    });
  }
  column.addEventListener('dragover', (e) => {
    if (!draggedGroupId || draggedGroupId === groupId || !groupId) return;
    e.preventDefault();
  });
  column.addEventListener('drop', async (e) => {
    if (!draggedGroupId || draggedGroupId === groupId || !groupId) return;
    e.preventDefault();
    e.stopPropagation();
    const board = column.parentElement;
    const ids = [...board.querySelectorAll('.group-column')].map((c) => c.dataset.groupId).filter(Boolean);
    const fromIdx = ids.indexOf(draggedGroupId);
    if (fromIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(ids.indexOf(groupId), 0, draggedGroupId);
    await window.lectureApp.reorderLectureGroups(subject, ids);
    openSubject(subject);
  });
  column.appendChild(header);

  const cardsWrap = document.createElement('div');
  cardsWrap.className = 'group-cards';
  if (lecturesInGroup.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'group-cards-empty';
    empty.textContent = t('library.emptyGroup');
    cardsWrap.appendChild(empty);
  }
  for (const lecture of lecturesInGroup) {
    const card = lectureCard(lecture, subject, () => openNote(subject, lecture, 'subject'));
    card.classList.add('card-compact');
    card.draggable = true;
    card.dataset.folderName = lecture.folderName;
    card.addEventListener('dragstart', (e) => {
      draggedLecture = lecture;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedLecture = null;
    });
    cardsWrap.appendChild(card);
  }

  cardsWrap.addEventListener('dragover', (e) => {
    if (!draggedLecture) return;
    e.preventDefault();
    cardsWrap.classList.add('drag-over');
  });
  cardsWrap.addEventListener('dragleave', (e) => {
    if (e.target === cardsWrap) cardsWrap.classList.remove('drag-over');
  });
  cardsWrap.addEventListener('drop', async (e) => {
    e.preventDefault();
    cardsWrap.classList.remove('drag-over');
    const dropped = draggedLecture;
    if (!dropped) return;

    const others = lecturesInGroup.filter((l) => l.folderName !== dropped.folderName);
    const targetCard = e.target.closest('.card');
    let newOrder;
    if (targetCard && targetCard.dataset.folderName && targetCard.dataset.folderName !== dropped.folderName) {
      const targetLecture = others.find((l) => l.folderName === targetCard.dataset.folderName);
      const idx = others.indexOf(targetLecture);
      const prevLecture = others[idx - 1];
      newOrder = computeOrderBetween(prevLecture ? prevLecture.order : null, targetLecture.order);
    } else {
      const last = others[others.length - 1];
      newOrder = computeOrderBetween(last ? last.order : null, null);
    }
    await window.lectureApp.setLecturePosition(subject, dropped.folderName, groupId, newOrder);
    openSubject(subject);
  });

  column.appendChild(cardsWrap);
  return column;
}

async function openNote(subject, lecture, backTo) {
  libraryState.view = 'note';
  libTitle.textContent = lecture.title;
  libBackBtn.style.display = 'flex';
  libBackBtn.onclick = () => (backTo === 'search' ? renderSearchResults() : openSubject(subject));
  document.getElementById('lib-review-btn').style.display = 'none';
  document.getElementById('lib-export-btn').style.display = 'none';
  const chatBtn = document.getElementById('lib-chat-btn');
  chatBtn.style.display = 'inline-flex';
  chatBtn.innerHTML = `${icon('chat', 14)}<span>${escapeHtml(t('library.chatByLecture'))}</span>`;
  chatBtn.onclick = async () => {
    const thread = await window.lectureApp.findOrCreateLectureThread(subject, lecture.folderName, t('chat.scopeSubjectTitle', { name: lecture.title }));
    openChatThread(thread.id, { backAction: () => openNote(subject, lecture, backTo) });
  };

  let markdown = await window.lectureApp.loadLecture(subject, lecture.folderName);
  const raw = await window.lectureApp.loadLectureRaw(subject, lecture.folderName);
  const hasRaw = Boolean(raw && (raw.transcript.length > 0 || raw.slides.length > 0));
  const savedAssignments = raw && raw.assignments ? raw.assignments : [];
  let showingOriginal = false;

  const dateStr = new Date(lecture.date).toLocaleString(getLang() === 'en' ? 'en-US' : 'ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const durationStr = lecture.durationSec > 0 ? ` · ${Math.round(lecture.durationSec / 60)} ${getLang() === 'en' ? 'min' : 'мин'}` : '';

  function renderOriginalHtml() {
    const lines = raw.transcript.map((s) => `<div class="transcript-line"><span class="ts">[${formatTimestamp(s.startSec)}]</span>${escapeHtml(s.text)}</div>`);
    return lines.join('') || `<p class="hint">${escapeHtml(t('note.transcriptEmpty'))}</p>`;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'note-view';
  wrapper.innerHTML = `
    <div class="note-view-head">
      <span class="note-meta">${dateStr}${durationStr}</span>
    </div>
    <div class="note-view-body">
      <div class="note-main">
        <div class="notes scroll-box" id="note-render">${renderMarkdown(markdown) || `<p class="hint">${escapeHtml(t('note.empty'))}</p>`}</div>
        <textarea id="note-editor" class="note-editor" style="display:none"></textarea>
        <div class="modal-actions" id="note-edit-actions" style="display:none">
          <button class="ghost-btn" id="note-cancel-btn">${escapeHtml(t('note.cancel'))}</button>
          <button class="primary-btn" id="note-save-btn">${escapeHtml(t('note.saveBtn'))}</button>
        </div>
      </div>
      <div class="note-actions" id="note-actions">
        ${hasRaw ? `
        <div class="detail-toggle" id="note-detail-toggle">
          <button type="button" class="detail-toggle-btn active" data-level="concise">${escapeHtml(t('note.concise'))}</button>
          <button type="button" class="detail-toggle-btn" data-level="detailed">${escapeHtml(t('note.detailed'))}</button>
        </div>` : ''}
        ${hasRaw ? `<button class="ghost-btn" id="note-rebuild-btn">${icon('file', 14)}<span>${escapeHtml(t('note.rebuild'))}</span></button>` : ''}
        ${hasRaw ? `<button class="ghost-btn" id="note-original-btn">${icon('mic', 14)}<span>${escapeHtml(t('note.whatRecorded'))}</span></button>` : ''}
        <button class="ghost-btn" id="note-quiz-btn">${icon('help', 14)}<span>${escapeHtml(t('note.quiz'))}</span></button>
        <button class="ghost-btn" id="note-flashcards-btn">${icon('cards', 14)}<span>${escapeHtml(t('flashcards.button'))}</span></button>
        <button class="ghost-btn" id="note-record-btn">${icon('mic', 14)}<span>${escapeHtml(t('note.recordMore'))}</span></button>
        <button class="ghost-btn" id="note-edit-btn">${icon('pencil', 14)}<span>${escapeHtml(t('note.edit'))}</span></button>
        <button class="ghost-btn" id="note-copy-btn">${icon('copy', 14)}<span>${escapeHtml(t('note.copy'))}</span></button>
        <button class="ghost-btn" id="note-export-btn">${icon('download', 14)}<span>${escapeHtml(t('note.export'))}</span></button>
        <div class="note-outline" id="note-outline" style="display:none">
          <div class="note-outline-head">${escapeHtml(t('note.outlineHead'))}</div>
          <div class="note-outline-list" id="note-outline-list"></div>
        </div>
        ${savedAssignments.length > 0 ? `
        <div class="note-outline note-assignments-block">
          <div class="note-outline-head">${escapeHtml(t('assignments.detectedHead'))}</div>
          <div id="note-assignments-list"></div>
        </div>` : ''}
        <div class="note-outline note-photos-block">
          <div class="note-photos-head">
            <span class="note-outline-head">${escapeHtml(t('note.photos'))}</span>
            <button class="note-photos-add-btn" id="note-photos-add-btn" title="${escapeHtml(t('note.photosAdd'))}">${icon('plus', 13)}</button>
          </div>
          <div class="note-photos-grid" id="note-photos-grid"></div>
        </div>
      </div>
    </div>
  `;
  setContent(wrapper);
  wrapper.querySelector('#note-copy-btn').addEventListener('click', () => window.lectureApp.copyNotes(markdown));
  wrapper.querySelector('#note-record-btn').addEventListener('click', () =>
    openRecordingView(subject, lecture, () => openNote(subject, lecture, backTo))
  );
  if (savedAssignments.length > 0) {
    const listEl = wrapper.querySelector('#note-assignments-list');
    for (const entry of savedAssignments) listEl.appendChild(assignmentRow(entry));
  }

  const photosGrid = wrapper.querySelector('#note-photos-grid');
  async function renderPhotos() {
    const fileNames = await window.lectureApp.listLecturePhotos(subject, lecture.folderName);
    photosGrid.innerHTML = '';
    if (fileNames.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'note-photos-empty';
      empty.textContent = t('note.photosEmpty');
      photosGrid.appendChild(empty);
      return;
    }
    for (const fileName of fileNames) {
      const thumb = document.createElement('div');
      thumb.className = 'note-photo-thumb';
      thumb.innerHTML = `<button class="note-photo-thumb-delete">${icon('winClose', 11)}</button>`;
      const img = document.createElement('img');
      window.lectureApp.getLecturePhoto(subject, lecture.folderName, fileName).then((dataUrl) => {
        img.src = dataUrl;
      });
      thumb.prepend(img);
      thumb.addEventListener('click', async () => {
        const dataUrl = await window.lectureApp.getLecturePhoto(subject, lecture.folderName, fileName);
        openPhotoLightbox(dataUrl);
      });
      thumb.querySelector('.note-photo-thumb-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.lectureApp.deleteLecturePhoto(subject, lecture.folderName, fileName);
        renderPhotos();
      });
      photosGrid.appendChild(thumb);
    }
  }
  renderPhotos();

  const photosAddBtn = wrapper.querySelector('#note-photos-add-btn');
  photosAddBtn.addEventListener('click', async () => {
    const original = photosAddBtn.innerHTML;
    photosAddBtn.disabled = true;
    photosAddBtn.innerHTML = `${rubyGemSvg(13)}`;
    try {
      const { fileNames, markdown: updatedMarkdown } = await window.lectureApp.addLecturePhotos(subject, lecture.folderName, selectedDetailLevel);
      if (fileNames.length > 0) renderPhotos();
      if (updatedMarkdown) {
        markdown = updatedMarkdown;
        editorEl.value = markdown;
        if (!showingOriginal && !showingQuiz) showNotes();
      }
    } finally {
      photosAddBtn.disabled = false;
      photosAddBtn.innerHTML = original;
    }
  });

  const exportBtn = wrapper.querySelector('#note-export-btn');
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: t('note.exportPdf'), icon: 'download', onClick: () => runExport('pdf') },
      { label: t('note.exportDoc'), icon: 'download', onClick: () => runExport('doc') },
    ]);
  });
  async function runExport(format) {
    const original = exportBtn.innerHTML;
    exportBtn.disabled = true;
    try {
      await window.lectureApp.exportNote(lecture.title, wrapper.querySelector('#note-render').innerHTML, format);
    } finally {
      exportBtn.disabled = false;
      exportBtn.innerHTML = original;
    }
  }

  const flashcardsBtn = wrapper.querySelector('#note-flashcards-btn');
  flashcardsBtn.addEventListener('click', async () => {
    const original = flashcardsBtn.innerHTML;
    let cards = await window.lectureApp.loadFlashcards(subject, lecture.folderName);
    if (cards.length === 0) {
      flashcardsBtn.disabled = true;
      flashcardsBtn.innerHTML = `${rubyGemSvg(14)}<span>${escapeHtml(t('flashcards.generating'))}</span>`;
      try {
        cards = await window.lectureApp.generateFlashcards(subject, lecture.folderName);
      } catch (err) {
        showAlert(t('flashcards.generateFailedTitle'), String(err.message || err));
        return;
      } finally {
        flashcardsBtn.disabled = false;
        flashcardsBtn.innerHTML = original;
      }
      if (cards.length === 0) {
        showAlert(t('flashcards.generateFailedTitle'), t('flashcards.generateEmptyMsg'));
        return;
      }
    }
    const now = Date.now();
    const due = cards.filter((c) => new Date(c.dueAt).getTime() <= now);
    const queue = (due.length > 0 ? due : cards).map((card) => ({ subject, folderName: lecture.folderName, card }));
    openFlashcardReview(queue);
  });

  const renderEl = wrapper.querySelector('#note-render');
  const editorEl = wrapper.querySelector('#note-editor');
  const editActionsEl = wrapper.querySelector('#note-edit-actions');
  const editBtn = wrapper.querySelector('#note-edit-btn');
  const rebuildBtn = wrapper.querySelector('#note-rebuild-btn');
  const originalBtn = wrapper.querySelector('#note-original-btn');
  const quizBtn = wrapper.querySelector('#note-quiz-btn');
  const detailToggle = wrapper.querySelector('#note-detail-toggle');
  const outlineEl = wrapper.querySelector('#note-outline');
  const outlineListEl = wrapper.querySelector('#note-outline-list');
  editorEl.value = markdown;

  let showingQuiz = false;
  let quizText = null;
  let selectedDetailLevel = 'concise';

  // A quick jump-to-section list, built from the conspect's own "## "
  // headings - clicking one scrolls that part of the note into view and
  // flashes it briefly, so it's obvious which section you landed on.
  function renderOutline() {
    const headings = extractHeadings(markdown);
    outlineListEl.innerHTML = '';
    if (headings.length === 0) {
      outlineEl.style.display = 'none';
      return;
    }
    outlineEl.style.display = '';
    for (const h of headings) {
      const row = document.createElement('div');
      row.className = 'note-outline-row';
      row.style.paddingLeft = `${(h.level - 2) * 12 + 8}px`;
      row.textContent = h.text;
      row.addEventListener('click', () => jumpToHeading(h.id));
      outlineListEl.appendChild(row);
    }
  }

  function jumpToHeading(id) {
    const target = renderEl.querySelector(`#${id}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.remove('note-heading-flash');
    void target.offsetWidth; // restart the CSS animation if clicked again
    target.classList.add('note-heading-flash');
    target.addEventListener('animationend', () => target.classList.remove('note-heading-flash'), { once: true });
  }

  renderOutline();

  if (detailToggle) {
    detailToggle.querySelectorAll('.detail-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedDetailLevel = btn.dataset.level;
        detailToggle.querySelectorAll('.detail-toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
  }

  function setEditing(editing) {
    renderEl.style.display = editing ? 'none' : 'block';
    editBtn.style.display = editing ? 'none' : 'inline-flex';
    editorEl.style.display = editing ? 'block' : 'none';
    editActionsEl.style.display = editing ? 'flex' : 'none';
    if (rebuildBtn) rebuildBtn.style.display = editing ? 'none' : 'inline-flex';
    if (originalBtn) originalBtn.style.display = editing ? 'none' : 'inline-flex';
    if (detailToggle) detailToggle.style.display = editing ? 'none' : 'flex';
    quizBtn.style.display = editing ? 'none' : 'inline-flex';
    if (editing) outlineEl.style.display = 'none';
    else renderOutline();
  }

  function showNotes() {
    showingOriginal = false;
    showingQuiz = false;
    renderEl.innerHTML = renderMarkdown(markdown) || `<p class="hint">${escapeHtml(t('note.empty'))}</p>`;
    if (originalBtn) originalBtn.innerHTML = `${icon('mic', 14)}<span>${escapeHtml(t('note.whatRecorded'))}</span>`;
    quizBtn.innerHTML = `${icon('help', 14)}<span>${escapeHtml(t('note.quiz'))}</span>`;
    renderOutline();
  }

  function showOriginal() {
    showingOriginal = true;
    showingQuiz = false;
    renderEl.innerHTML = renderOriginalHtml();
    if (originalBtn) originalBtn.innerHTML = `${icon('file', 14)}<span>${escapeHtml(t('note.showConspect'))}</span>`;
    quizBtn.innerHTML = `${icon('help', 14)}<span>${escapeHtml(t('note.quiz'))}</span>`;
    outlineEl.style.display = 'none';
  }

  async function showQuiz() {
    if (showingQuiz) {
      showNotes();
      return;
    }
    showingOriginal = false;
    showingQuiz = true;
    if (originalBtn) originalBtn.innerHTML = `${icon('mic', 14)}<span>${escapeHtml(t('note.whatRecorded'))}</span>`;
    outlineEl.style.display = 'none';
    if (quizText !== null) {
      renderEl.innerHTML = renderMarkdown(quizText);
      quizBtn.innerHTML = `${icon('file', 14)}<span>${escapeHtml(t('note.quizBack'))}</span>`;
      return;
    }
    const original = quizBtn.innerHTML;
    quizBtn.disabled = true;
    quizBtn.innerHTML = `${rubyGemSvg(14)}<span>${escapeHtml(t('note.quizPreparing'))}</span>`;
    renderEl.innerHTML = `<p class="hint">${escapeHtml(t('note.quizPreparing'))}</p>`;
    try {
      quizText = await window.lectureApp.generateQuiz(subject, lecture.folderName);
      renderEl.innerHTML = renderMarkdown(quizText);
      quizBtn.innerHTML = `${icon('file', 14)}<span>${escapeHtml(t('note.quizBack'))}</span>`;
    } catch (err) {
      showingQuiz = false;
      renderEl.innerHTML = `<p class="hint" style="color:var(--danger)">${escapeHtml(t('note.quizFailed', { error: String(err.message || err) }))}</p>`;
      quizBtn.innerHTML = original;
    } finally {
      quizBtn.disabled = false;
    }
  }

  quizBtn.addEventListener('click', showQuiz);

  // `isManual` distinguishes a user-clicked rebuild from the silent
  // auto-retry below: a failure the user asked for deserves visible
  // feedback, but a background retry failing shouldn't blow away whatever
  // was already on screen (the raw-transcript fallback is still genuinely
  // useful) - it previously did exactly that, replacing real content with
  // nothing but an error message and no way back to it short of reopening
  // the note.
  async function rebuildNotes(isManual = false) {
    if (!rebuildBtn) return;
    const original = rebuildBtn.innerHTML;
    rebuildBtn.disabled = true;
    rebuildBtn.innerHTML = `${rubyGemSvg(14)}<span>${escapeHtml(t('note.rebuilding'))}</span>`;
    try {
      markdown = await window.lectureApp.rebuildLectureNotes(subject, lecture.folderName, selectedDetailLevel);
      editorEl.value = markdown;
      lecture.notesFailed = false;
      quizText = null; // stale now that the underlying notes changed
      if (!showingOriginal && !showingQuiz) showNotes();
    } catch (err) {
      if (isManual) {
        const raw = String(err.message || err);
        const message = /503|UNAVAILABLE|overloaded|высок(?:ий|ая) спрос/i.test(raw)
          ? t('note.rebuildFailedOverload')
          : /429|rate.?limit/i.test(raw)
            ? t('note.rebuildFailedRateLimit')
            : /reduce the length|context.?length|too many tokens/i.test(raw)
              ? t('note.rebuildFailedTooLong')
              : t('note.rebuildFailedGeneric', { error: raw });
        showAlert(t('note.rebuild'), message);
      }
    } finally {
      rebuildBtn.disabled = false;
      rebuildBtn.innerHTML = original;
    }
  }

  if (rebuildBtn) rebuildBtn.addEventListener('click', () => rebuildNotes(true));
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
  libTitle.textContent = t('library.searchResults');
  libBackBtn.style.display = 'none';
  document.getElementById('lib-chat-btn').style.display = 'none';
  document.getElementById('lib-export-btn').style.display = 'none';
  document.getElementById('lib-review-btn').style.display = 'none';

  const query = searchInput.value.trim();
  const { subjects, lectures } = await window.lectureApp.searchLectures(query);
  const scheduleMatches = await searchSchedule(query);
  if (subjects.length === 0 && lectures.length === 0 && scheduleMatches.length === 0) {
    setContent(emptyState(t('library.notFound')));
    return;
  }
  const wrapper = document.createElement('div');
  const grid = document.createElement('div');
  grid.className = 'card-grid';
  for (const subject of subjects) {
    const count = (await window.lectureApp.listLectures(subject)).length;
    grid.appendChild(
      subjectCard(subject, count, () => openSubject(subject), {
        onRename: async () => {
          const newName = await askText(t('library.renameSubjectPrompt'), subject);
          if (!newName || newName === subject) return;
          await window.lectureApp.renameSubject(subject, newName);
          renderSearchResults();
        },
        onDelete: async () => {
          const ok = await askConfirm(t('library.deleteSubjectTitle'), t('library.deleteSubjectMsg', { name: subject }));
          if (!ok) return;
          await window.lectureApp.deleteSubject(subject);
          renderSearchResults();
        },
      })
    );
  }
  const groupNamesBySubject = new Map(); // subject -> Map(groupId -> name)
  for (const lecture of lectures) {
    if (lecture.groupId && !groupNamesBySubject.has(lecture.subject)) {
      const meta = await window.lectureApp.getSubjectMeta(lecture.subject);
      groupNamesBySubject.set(lecture.subject, new Map(meta.groups.map((g) => [g.id, g.name])));
    }
    const groupName = lecture.groupId ? groupNamesBySubject.get(lecture.subject)?.get(lecture.groupId) ?? null : null;
    grid.appendChild(lectureCard(lecture, lecture.subject, () => openNote(lecture.subject, lecture, 'search'), true, groupName));
  }
  wrapper.appendChild(grid);

  if (scheduleMatches.length > 0) {
    const section = document.createElement('div');
    section.className = 'calendar-day-section search-schedule-section';
    const title = document.createElement('div');
    title.className = 'calendar-day-title';
    title.textContent = t('calendar.title');
    section.appendChild(title);
    for (const entry of scheduleMatches) section.appendChild(calendarEntryRow(entry, entry.type === 'once', false));
    wrapper.appendChild(section);
  }

  setContent(wrapper);
}

async function searchSchedule(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const entries = await window.lectureApp.listSchedule();
  return entries.filter((e) => [e.title, e.subject, e.category, e.location, e.teacher].some((f) => f && f.toLowerCase().includes(q)));
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
      { label: t('library.rename'), icon: 'pencil', onClick: onRename },
      { label: t('library.delete'), icon: 'trash', danger: true, onClick: onDelete },
    ]);
  });
  return card;
}

function lectureCard(lecture, subject, onClick, showSubjectTag = false, groupName = null) {
  const date = new Date(lecture.date).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU', { day: 'numeric', month: 'short' });
  const card = document.createElement('div');
  card.className = 'card';
  const tagText = showSubjectTag ? [subject, groupName].filter(Boolean).join(' · ') : '';
  card.innerHTML = `
    <div class="card-tile" style="background:var(--bg-active); color:var(--text-muted)">${icon('file', 18)}</div>
    <button class="card-menu-btn">${icon('more', 16)}</button>
    <div class="card-title">${escapeHtml(lecture.title)}</div>
    ${tagText ? `<div class="search-tag">${escapeHtml(tagText)}</div>` : ''}
    ${lecture.matchSnippet ? `<div class="search-snippet">${escapeHtml(lecture.matchSnippet)}</div>` : ''}
    <div class="card-meta">${date} · ${Math.round(lecture.durationSec / 60)} ${getLang() === 'en' ? 'min' : 'мин'}</div>
  `;
  card.addEventListener('click', () => onClick());
  card.querySelector('.card-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      {
        label: t('library.rename'),
        icon: 'pencil',
        onClick: async () => {
          const newTitle = await askText(t('library.renameLecturePrompt'), lecture.title);
          if (!newTitle || newTitle === lecture.title) return;
          await window.lectureApp.renameLecture(subject, lecture.folderName, newTitle);
          libraryState.view === 'search' ? renderSearchResults() : openSubject(subject);
        },
      },
      {
        label: t('library.delete'),
        icon: 'trash',
        danger: true,
        onClick: async () => {
          const ok = await askConfirm(t('library.deleteLectureTitle'), t('library.deleteLectureMsg', { name: lecture.title }));
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

// --- Chat with AI: named, persisted threads (storage/chatStore.ts on the
// main side) instead of one in-memory conversation that vanished on every
// restart. A thread is either general-purpose (user-named, e.g. "ДЗ") or
// tied to a subject/lecture via "Чат по предмету/лекции". ---
let currentThreadId = null;
let chatHistory = []; // { role: 'user'|'model', text } - the currently open thread's messages
let chatBackAction = null; // () => void, or null to hide the back button

const chatThreadViewEl = document.getElementById('chat-thread-view');
const chatSidebarListEl = document.getElementById('chat-sidebar-list');

document.getElementById('chat-back-btn').innerHTML = icon('chevronLeft', 18);
document.getElementById('chat-back-btn').addEventListener('click', () => {
  if (chatBackAction) chatBackAction();
});
document.getElementById('chat-sidebar-new-btn').innerHTML = `${icon('plus', 14)}<span>${escapeHtml(t('chat.sidebarNew'))}</span>`;
document.getElementById('chat-sidebar-new-btn').addEventListener('click', async () => {
  const thread = await window.lectureApp.createChatThread(t('chat.newChatTitle'));
  await renderChatSidebar();
  openChatThread(thread.id);
});

function setChatBack(action) {
  chatBackAction = action;
  document.getElementById('chat-back-btn').style.display = action ? '' : 'none';
}

function chatSidebarRow(thread) {
  const row = document.createElement('div');
  row.className = 'chat-sidebar-row' + (thread.id === currentThreadId ? ' active' : '');
  row.innerHTML = `
    <span class="chat-sidebar-row-title">${escapeHtml(thread.title)}</span>
    <button class="chat-sidebar-row-menu">${icon('more', 14)}</button>
  `;
  row.addEventListener('click', () => openChatThread(thread.id));
  row.querySelector('.chat-sidebar-row-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      {
        label: t('library.rename'),
        icon: 'pencil',
        onClick: async () => {
          const newTitle = await askText(t('chat.renameTitle'), thread.title);
          if (!newTitle || newTitle === thread.title) return;
          await window.lectureApp.renameChatThread(thread.id, newTitle);
          if (thread.id === currentThreadId) document.getElementById('chat-title').textContent = newTitle;
          renderChatSidebar();
        },
      },
      {
        label: t('library.delete'),
        icon: 'trash',
        danger: true,
        onClick: async () => {
          const ok = await askConfirm(t('chat.deleteTitle'), t('chat.deleteMsg', { title: thread.title }));
          if (!ok) return;
          await window.lectureApp.deleteChatThread(thread.id);
          if (localStorage.getItem('lastChatThreadId') === thread.id) localStorage.removeItem('lastChatThreadId');
          if (thread.id === currentThreadId) initChat();
          else renderChatSidebar();
        },
      },
    ]);
  });
  return row;
}

/** Repopulates the persistent left sidebar - only general-purpose threads
 * show here; a subject/lecture-scoped chat is reached via "Чат по
 * предмету/лекции" instead, so it doesn't clutter this list. */
async function renderChatSidebar() {
  const threads = await window.lectureApp.listChatThreads();
  const generalThreads = threads.filter((thread) => !thread.subject && !thread.folderName);
  chatSidebarListEl.innerHTML = '';
  if (generalThreads.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint chat-sidebar-empty';
    hint.textContent = t('chat.sidebarEmpty');
    chatSidebarListEl.appendChild(hint);
    return;
  }
  for (const thread of generalThreads) chatSidebarListEl.appendChild(chatSidebarRow(thread));
}

async function openChatThread(id, { backAction = null } = {}) {
  const thread = await window.lectureApp.loadChatThread(id);
  if (!thread) return;
  switchToTab('chat');
  currentThreadId = id;
  chatHistory = thread.messages.map((m) => ({ role: m.role, text: m.text }));
  if (!thread.subject && !thread.folderName) localStorage.setItem('lastChatThreadId', id);

  document.getElementById('chat-title').textContent = thread.title;
  setChatBack(backAction);
  chatThreadViewEl.style.display = '';

  const messagesEl = document.getElementById('chat-messages');
  messagesEl.innerHTML = '';
  if (chatHistory.length === 0) {
    messagesEl.innerHTML = `<p class="hint">${escapeHtml(thread.subject || thread.folderName ? t('chat.hintScoped') : t('chat.hintGlobal'))}</p>`;
  } else {
    for (const msg of chatHistory) appendChatBubble(msg.role, msg.text);
  }
  document.getElementById('chat-input').focus();
  renderChatSidebar();
}

/** Opens straight into a chat on launch (rather than a picker) - reopens the
 * last-used general thread, falls back to any existing one, or creates a
 * fresh "Общий чат" the first time the app is ever run. */
async function initChat() {
  const lastId = localStorage.getItem('lastChatThreadId');
  let thread = lastId ? await window.lectureApp.loadChatThread(lastId) : null;
  if (!thread) {
    const threads = await window.lectureApp.listChatThreads();
    const general = threads.filter((thread) => !thread.subject && !thread.folderName);
    thread = general.length > 0 ? await window.lectureApp.loadChatThread(general[0].id) : null;
  }
  if (!thread) thread = await window.lectureApp.createChatThread(t('chat.generalChatTitle'));
  openChatThread(thread.id);
}

function appendChatBubble(role, text) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble chat-bubble-${role}`;
  bubble.innerHTML = renderMarkdown(text) || escapeHtml(text);
  document.getElementById('chat-messages').appendChild(bubble);
  document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;
  return bubble;
}

// Reply text streams in over IPC_CHAT_STREAM_DELTA as it's generated, but
// Groq in particular is fast enough that a whole short reply can arrive in
// one or two deltas - real streaming, but too instant to actually look like
// typing. `streamingRaw` tracks everything received so far; a separate
// ticker reveals it onto the bubble at a fixed pace, decoupled from however
// fast the network/model actually was, so it always reads like Ruby is
// typing rather than teleporting in text.
let streamingBubble = null;
let streamingRaw = '';
let streamingRevealed = '';
let streamingTicker = null;

const REVEAL_CHARS_PER_TICK = 2;
const REVEAL_INTERVAL_MS = 30;

// Forcing scrollTop to the bottom on every single tick made it impossible to
// scroll up and read earlier messages while a reply was still "typing" - the
// view snapped right back down on the very next tick. Only auto-follow while
// the user is already near the bottom (i.e. hasn't deliberately scrolled up
// to read something else); once they scroll away, leave them alone until
// they scroll back down themselves.
const AUTO_SCROLL_THRESHOLD_PX = 80;

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
}

function renderRevealed() {
  if (!streamingBubble) return;
  const messagesEl = document.getElementById('chat-messages');
  const shouldStickToBottom = isNearBottom(messagesEl);
  streamingBubble.innerHTML = renderMarkdown(streamingRevealed) || escapeHtml(streamingRevealed);
  if (shouldStickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function startRevealTicker() {
  stopRevealTicker();
  streamingTicker = setInterval(() => {
    if (streamingRevealed.length >= streamingRaw.length) return;
    streamingRevealed = streamingRaw.slice(0, streamingRevealed.length + REVEAL_CHARS_PER_TICK);
    renderRevealed();
  }, REVEAL_INTERVAL_MS);
}

function stopRevealTicker() {
  if (streamingTicker) {
    clearInterval(streamingTicker);
    streamingTicker = null;
  }
}

/** Resolves once the on-screen reveal has caught up to the full reply text. */
function waitForRevealToCatchUp() {
  return new Promise((resolve) => {
    (function check() {
      if (streamingRevealed.length >= streamingRaw.length) resolve();
      else setTimeout(check, REVEAL_INTERVAL_MS);
    })();
  });
}

window.lectureApp.onChatStreamDelta((delta) => {
  if (!streamingBubble) return;
  streamingRaw += delta;
});

async function sendChatMessage() {
  if (!currentThreadId) return;
  const sendBtn = document.getElementById('chat-send-btn');
  // The Enter-key handler below doesn't know about `disabled` on its own -
  // without this guard, pressing Enter again while a reply is still
  // streaming fired a second, overlapping chatSend() that stomped on the
  // same streamingBubble/streamingRaw globals as the first, leaving one
  // bubble stuck on "Ruby думает…" forever and the other rendering empty.
  if (sendBtn.disabled) return;
  const threadId = currentThreadId;
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';

  appendChatBubble('user', message);
  const thinkingBubble = appendChatBubble('model', '');
  thinkingBubble.innerHTML = `<div class="thinking-row">${rubyGemSvg(16)}<span class="thinking-label">${escapeHtml(t('chat.thinking'))}</span></div>`;

  const stopBtn = document.getElementById('chat-stop-btn');
  sendBtn.disabled = true;
  sendBtn.style.display = 'none';
  stopBtn.style.display = 'inline-flex';
  streamingBubble = thinkingBubble;
  streamingRaw = '';
  streamingRevealed = '';
  try {
    const replyPromise = window.lectureApp.chatSend(threadId, chatHistory, message);
    startRevealTicker();
    const reply = await replyPromise;
    chatHistory.push({ role: 'user', text: message }, { role: 'model', text: reply });
    streamingRaw = reply; // in case the final SSE frame lands after the promise resolves
    await waitForRevealToCatchUp();
    stopRevealTicker();
    thinkingBubble.innerHTML = renderMarkdown(reply) || `<p class="hint">${escapeHtml(t('chat.stoppedEmpty'))}</p>`;
  } catch (err) {
    stopRevealTicker();
    thinkingBubble.innerHTML = `<p class="hint" style="color:var(--danger)">${escapeHtml(t('chat.replyFailed'))}</p>`;
  } finally {
    streamingBubble = null;
    sendBtn.disabled = false;
    sendBtn.style.display = '';
    stopBtn.style.display = 'none';
  }
}

document.getElementById('chat-send-btn').addEventListener('click', sendChatMessage);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});
document.getElementById('chat-stop-btn').innerHTML = icon('stop', 14);
document.getElementById('chat-stop-btn').title = t('chat.stop');
document.getElementById('chat-stop-btn').addEventListener('click', () => {
  // Tries to cancel the actual network call (works while it's still really
  // in flight - Gemini in particular can take a while), but Groq is often
  // fast enough that the real reply already fully arrived and all that's
  // left is the paced-out typing effect catching up to it. Either way,
  // jumping the reveal straight to whatever's already been received makes
  // Stop feel instant instead of doing nothing until the animation finishes
  // on its own.
  window.lectureApp.chatStop();
  streamingRevealed = streamingRaw;
  renderRevealed();
});

// --- Flashcard review (spaced repetition) - one shared overlay for both a
// single lecture's "Карточки" button and the library-wide "due" review, so
// the queue is just a flat list of {subject, folderName, card} either way. ---
let flashcardQueue = [];
let flashcardIndex = 0;

document.getElementById('flashcard-close-btn').innerHTML = icon('winClose', 16);
document.getElementById('flashcard-close-btn').addEventListener('click', closeFlashcardReview);

function openFlashcardReview(queue) {
  flashcardQueue = queue;
  flashcardIndex = 0;
  document.getElementById('flashcard-overlay').style.display = 'flex';
  renderFlashcard();
}

function closeFlashcardReview() {
  document.getElementById('flashcard-overlay').style.display = 'none';
  flashcardQueue = [];
}

function renderFlashcard() {
  const progressEl = document.getElementById('flashcard-progress');
  const contentEl = document.getElementById('flashcard-content');
  const actionsEl = document.getElementById('flashcard-actions');

  if (flashcardIndex >= flashcardQueue.length) {
    progressEl.textContent = t('flashcards.done');
    contentEl.innerHTML = `<p class="hint">${escapeHtml(t('flashcards.doneHint'))}</p>`;
    actionsEl.innerHTML = '';
    return;
  }

  const { card } = flashcardQueue[flashcardIndex];
  progressEl.textContent = `${flashcardIndex + 1} / ${flashcardQueue.length}`;
  contentEl.innerHTML = `<div class="flashcard-face">${renderMarkdown(card.front) || escapeHtml(card.front)}</div>`;
  actionsEl.innerHTML = `<button class="primary-btn" id="flashcard-reveal-btn">${escapeHtml(t('flashcards.reveal'))}</button>`;
  document.getElementById('flashcard-reveal-btn').addEventListener('click', revealFlashcardBack);
}

function revealFlashcardBack() {
  const { card } = flashcardQueue[flashcardIndex];
  const contentEl = document.getElementById('flashcard-content');
  const actionsEl = document.getElementById('flashcard-actions');
  contentEl.innerHTML = `
    <div class="flashcard-face">${renderMarkdown(card.front) || escapeHtml(card.front)}</div>
    <div class="flashcard-divider"></div>
    <div class="flashcard-face flashcard-back">${renderMarkdown(card.back) || escapeHtml(card.back)}</div>
  `;
  const ratings = ['again', 'hard', 'good', 'easy'];
  actionsEl.innerHTML = ratings
    .map((r) => `<button class="ghost-btn flashcard-rate-btn" data-rating="${r}">${escapeHtml(t(`flashcards.${r}`))}</button>`)
    .join('');
  actionsEl.querySelectorAll('.flashcard-rate-btn').forEach((btn) => {
    btn.addEventListener('click', () => rateFlashcard(btn.dataset.rating));
  });
}

async function rateFlashcard(rating) {
  const entry = flashcardQueue[flashcardIndex];
  await window.lectureApp.reviewFlashcard(entry.subject, entry.folderName, entry.card.id, rating);
  // "Again" goes back into the queue instead of just moving on, so it comes
  // up again before the session ends - same as Anki's own "again" behavior.
  if (rating === 'again') flashcardQueue.push(entry);
  flashcardIndex++;
  renderFlashcard();
}

/** Pools every lecture's due cards into one queue - the "Повторение" entry point on the library grid, for reviewing across the whole library instead of one lecture at a time. */
async function openGlobalFlashcardReview(dueSummaries) {
  const now = Date.now();
  const queue = [];
  for (const s of dueSummaries) {
    const cards = await window.lectureApp.loadFlashcards(s.subject, s.folderName);
    for (const card of cards.filter((c) => new Date(c.dueAt).getTime() <= now)) {
      queue.push({ subject: s.subject, folderName: s.folderName, card });
    }
  }
  openFlashcardReview(queue);
}

// --- Settings tab ---
const settingsForm = document.getElementById('settings-form');
const settingsSaved = document.getElementById('settings-saved');
const apiKeyInput = document.getElementById('api-key-input');
const apiKeyStatus = document.getElementById('api-key-status');
const libraryPathInput = document.getElementById('library-path-input');

async function checkApiStatus() {
  const { configured } = await window.lectureApp.getApiStatus();
  document.getElementById('api-key-banner').style.display = configured ? 'none' : 'block';
  apiKeyStatus.textContent = configured ? t('settings.apiKeyConfigured') : t('settings.apiKeyMissing');
  apiKeyStatus.className = configured ? 'hint success' : 'hint';
  return configured;
}

const uiLanguageSelect = document.getElementById('ui-language-select');
uiLanguageSelect.value = getLang();
uiLanguageSelect.addEventListener('change', () => {
  setLang(uiLanguageSelect.value);
  // Simplest reliable way to re-render every dynamically-built label in the
  // new language - equivalent to a normal relaunch, which the app already
  // handles cleanly (reopens straight into the last chat, etc).
  location.reload();
});

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
  groqKeyStatus.textContent = configured ? t('settings.groqConfigured') : t('settings.groqMissing');
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

const cloudflareAccountInput = document.getElementById('cloudflare-account-input');
const cloudflareTokenInput = document.getElementById('cloudflare-token-input');
const cloudflareStatus = document.getElementById('cloudflare-status');

async function checkCloudflareApiStatus() {
  const { configured } = await window.lectureApp.getCloudflareApiStatus();
  cloudflareStatus.textContent = configured ? t('settings.cloudflareConfigured') : t('settings.cloudflareMissing');
  cloudflareStatus.className = configured ? 'hint success' : 'hint';
}

document.getElementById('save-cloudflare-btn').addEventListener('click', async () => {
  const accountId = cloudflareAccountInput.value.trim();
  const apiToken = cloudflareTokenInput.value.trim();
  if (!accountId || !apiToken) return;
  await window.lectureApp.saveCloudflareCredentials(accountId, apiToken);
  cloudflareAccountInput.value = '';
  cloudflareTokenInput.value = '';
  checkCloudflareApiStatus();
});

document.getElementById('clear-cloudflare-btn').addEventListener('click', async () => {
  await window.lectureApp.clearCloudflareCredentials();
  checkCloudflareApiStatus();
});

document.getElementById('choose-folder-btn').addEventListener('click', async () => {
  const chosen = await window.lectureApp.chooseLibraryFolder();
  if (chosen) libraryPathInput.value = chosen;
});

document.getElementById('reveal-folder-btn').addEventListener('click', () => {
  window.lectureApp.revealLibraryFolder();
});

const backupBtn = document.getElementById('backup-library-btn');
const backupStatus = document.getElementById('backup-status');
backupBtn.addEventListener('click', async () => {
  const original = backupBtn.textContent;
  backupBtn.disabled = true;
  backupStatus.textContent = '';
  try {
    const { saved } = await window.lectureApp.exportLibraryBackup();
    if (saved) {
      backupStatus.textContent = t('settings.storage.backupDone');
      backupStatus.className = 'hint success';
    }
  } catch (err) {
    backupStatus.textContent = String(err.message || err);
    backupStatus.className = 'hint';
  } finally {
    backupBtn.disabled = false;
    backupBtn.textContent = original;
    setTimeout(() => (backupStatus.textContent = ''), 5000);
  }
});

async function loadSettingsIntoForm() {
  const settings = await window.lectureApp.getSettings();
  for (const [key, value] of Object.entries(settings)) {
    const field = settingsForm.elements.namedItem(key);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
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
    autoStopSilenceEnabled: formData.get('autoStopSilenceEnabled') === 'on',
  };
  await window.lectureApp.saveSettings(settings);
  settingsSaved.textContent = t('settings.savedHint');
  settingsSaved.className = 'hint success';
  setTimeout(() => (settingsSaved.textContent = ''), 4000);
});

// --- Calendar: a weekly class timetable (plus one-off events), stored
// once per library rather than per subject - see scheduleStore.ts. ---
function mondayFirstDayIndex(date) {
  return (date.getDay() + 6) % 7;
}

async function openCalendar() {
  const entries = await window.lectureApp.listSchedule();
  const content = document.getElementById('calendar-content');
  content.innerHTML = '';

  const todayIdx = mondayFirstDayIndex(new Date());
  const todayCount = entries.filter((e) => e.type === 'weekly' ? e.dayOfWeek === todayIdx : e.date === new Date().toISOString().slice(0, 10)).length;
  const weekCount = entries.filter((e) => e.type === 'weekly').length;

  const stats = document.createElement('div');
  stats.className = 'calendar-stats';
  stats.innerHTML = `
    <div class="calendar-stat"><span class="calendar-stat-num">${todayCount}</span><span class="calendar-stat-label">${escapeHtml(t('calendar.today.count', { count: todayCount }))}</span></div>
    <div class="calendar-stat"><span class="calendar-stat-num">${weekCount}</span><span class="calendar-stat-label">${escapeHtml(t('calendar.week.count', { count: weekCount }))}</span></div>
  `;
  content.appendChild(stats);

  // Days start from today and wrap around, rather than always Monday-first -
  // glancing at the calendar should show what's coming up next, not
  // whichever day already happened earlier this week.
  for (let offset = 0; offset < 7; offset++) {
    const day = (todayIdx + offset) % 7;
    const dayEntries = entries
      .filter((e) => e.type === 'weekly' && e.dayOfWeek === day)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));

    const section = document.createElement('div');
    section.className = 'calendar-day-section';
    const title = document.createElement('div');
    title.className = 'calendar-day-title';
    title.textContent = t(`calendar.day.${day}`) + (day === todayIdx ? ` · ${t('common.today')}` : '');
    section.appendChild(title);

    if (dayEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'calendar-day-empty';
      empty.textContent = t('calendar.empty');
      section.appendChild(empty);
    } else {
      for (const entry of dayEntries) section.appendChild(calendarEntryRow(entry, false, day === todayIdx));
    }
    content.appendChild(section);
  }

  const onceEntries = entries
    .filter((e) => e.type === 'once')
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  if (onceEntries.length > 0) {
    const section = document.createElement('div');
    section.className = 'calendar-day-section';
    const title = document.createElement('div');
    title.className = 'calendar-day-title';
    title.textContent = t('calendar.upcoming');
    section.appendChild(title);
    const todayKey = new Date().toISOString().slice(0, 10);
    for (const entry of onceEntries) section.appendChild(calendarEntryRow(entry, true, entry.date === todayKey));
    content.appendChild(section);
  }
}

function isHappeningNow(entry, isToday) {
  if (!isToday || !entry.endTime) return false;
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = entry.startTime.split(':').map(Number);
  const [endH, endM] = entry.endTime.split(':').map(Number);
  return nowMinutes >= startH * 60 + startM && nowMinutes < endH * 60 + endM;
}

function calendarEntryRow(entry, showDate, isToday) {
  const row = document.createElement('div');
  const liveNow = isHappeningNow(entry, isToday);
  row.className = 'calendar-entry' + (isToday ? ' calendar-entry-today' : '') + (liveNow ? ' calendar-entry-live' : '');
  const dateLabel = showDate && entry.date ? new Date(entry.date).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU', { day: 'numeric', month: 'short' }) + ' · ' : '';
  const metaParts = [entry.subject, entry.category, entry.location, entry.teacher].filter(Boolean);
  row.innerHTML = `
    <div class="calendar-entry-time">${escapeHtml(dateLabel)}${escapeHtml(entry.startTime)}${entry.endTime ? '–' + escapeHtml(entry.endTime) : ''}</div>
    <div class="calendar-entry-body">
      <div class="calendar-entry-title">${escapeHtml(entry.title)}${liveNow ? `<span class="calendar-live-badge">${escapeHtml(t('calendar.liveNow'))}</span>` : ''}</div>
      ${metaParts.length ? `<div class="calendar-entry-meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
    </div>
    <button class="calendar-entry-record-btn" title="${escapeHtml(t('calendar.record'))}">${icon('record', 13)}</button>
    <button class="calendar-entry-menu-btn">${icon('more', 15)}</button>
  `;
  row.addEventListener('click', () => openScheduleModal(entry));
  const recordBtn = row.querySelector('.calendar-entry-record-btn');
  if (recordBtn) {
    recordBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startRecordingFromCalendarEntry(entry);
    });
  }
  row.querySelector('.calendar-entry-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(e.currentTarget, [
      { label: t('note.edit'), icon: 'pencil', onClick: () => openScheduleModal(entry) },
      {
        label: t('library.delete'),
        icon: 'trash',
        danger: true,
        onClick: async () => {
          const ok = await askConfirm(t('calendar.deleteTitle'), t('calendar.deleteMsg', { name: entry.title }));
          if (!ok) return;
          await window.lectureApp.deleteScheduleEntry(entry.id);
          openCalendar();
        },
      },
    ]);
  });
  return row;
}

// Starting a recording from a calendar entry links the two previously
// independent modules: it resolves (or creates) the subject's group that
// matches the entry's free-form category, so the recording lands in the
// same column the user would have filed it under by hand.
async function startRecordingFromCalendarEntry(entry) {
  if (!entry.subject) {
    showAlert(t('calendar.record'), t('calendar.recordNeedsSubject'));
    return;
  }
  let groupId;
  if (entry.category) {
    const subjectMeta = await window.lectureApp.getSubjectMeta(entry.subject);
    const existing = subjectMeta.groups.find((g) => g.name.trim().toLowerCase() === entry.category.trim().toLowerCase());
    groupId = existing ? existing.id : (await window.lectureApp.createLectureGroup(entry.subject, entry.category)).id;
  }
  const dateLabel = new Date().toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ru-RU', { day: 'numeric', month: 'long' });
  const meta = await window.lectureApp.createLecture(entry.subject, `${entry.title} · ${dateLabel}`, groupId);
  openRecordingView(entry.subject, meta, () => {
    switchToTab('calendar');
    openCalendar();
  });
}

document.getElementById('calendar-add-btn').innerHTML = `${icon('plus', 16)}<span>${escapeHtml(t('calendar.add'))}</span>`;
document.getElementById('schedule-modal-close-btn').innerHTML = icon('winClose', 15);

const scheduleModalOverlay = document.getElementById('schedule-modal-overlay');
const scheduleForm = document.getElementById('schedule-form');
const scheduleDayRow = document.getElementById('schedule-day-row');
const scheduleDateRow = document.getElementById('schedule-date-row');
const scheduleDeleteBtn = document.getElementById('schedule-delete-btn');
let editingScheduleId = null;

function updateScheduleTypeRows() {
  const type = scheduleForm.querySelector('input[name="schedule-type"]:checked').value;
  scheduleDayRow.style.display = type === 'weekly' ? '' : 'none';
  scheduleDateRow.style.display = type === 'once' ? '' : 'none';
}
scheduleForm.querySelectorAll('input[name="schedule-type"]').forEach((el) => el.addEventListener('change', updateScheduleTypeRows));

async function openScheduleModal(entry) {
  editingScheduleId = entry ? entry.id : null;
  document.getElementById('schedule-modal-title').textContent = t(entry ? 'calendar.editTitle' : 'calendar.addTitle');
  scheduleDeleteBtn.style.display = entry ? '' : 'none';

  const subjectSelect = document.getElementById('schedule-subject-select');
  const subjects = await window.lectureApp.listSubjects();
  subjectSelect.innerHTML = `<option value="">${escapeHtml(t('calendar.field.subjectNone'))}</option>`;
  for (const subject of subjects) {
    const option = document.createElement('option');
    option.value = subject;
    option.textContent = subject;
    subjectSelect.appendChild(option);
  }
  subjectSelect.value = entry?.subject || '';

  document.getElementById('schedule-title-input').value = entry ? entry.title : '';
  document.getElementById('schedule-category-input').value = entry?.category || '';
  const type = entry ? entry.type : 'weekly';
  scheduleForm.querySelector(`input[name="schedule-type"][value="${type}"]`).checked = true;
  document.getElementById('schedule-day-select').value = String(entry ? entry.dayOfWeek ?? 0 : mondayFirstDayIndex(new Date()));
  document.getElementById('schedule-date-input').value = entry?.date || new Date().toISOString().slice(0, 10);
  document.getElementById('schedule-start-input').value = entry ? entry.startTime : '';
  document.getElementById('schedule-end-input').value = entry ? entry.endTime || '' : '';
  document.getElementById('schedule-location-input').value = entry?.location || '';
  document.getElementById('schedule-teacher-input').value = entry?.teacher || '';
  document.getElementById('schedule-notify-select').value = String(entry ? entry.notifyMinutesBefore : 10);
  updateScheduleTypeRows();

  scheduleModalOverlay.style.display = 'flex';
}
function closeScheduleModal() {
  scheduleModalOverlay.style.display = 'none';
}

document.getElementById('calendar-add-btn').addEventListener('click', () => openScheduleModal(null));
document.getElementById('schedule-modal-close-btn').addEventListener('click', closeScheduleModal);
scheduleModalOverlay.addEventListener('click', (e) => {
  if (e.target === scheduleModalOverlay) closeScheduleModal();
});

scheduleDeleteBtn.addEventListener('click', async () => {
  const title = document.getElementById('schedule-title-input').value.trim();
  const ok = await askConfirm(t('calendar.deleteTitle'), t('calendar.deleteMsg', { name: title }));
  if (!ok) return;
  await window.lectureApp.deleteScheduleEntry(editingScheduleId);
  closeScheduleModal();
  openCalendar();
});

scheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const type = scheduleForm.querySelector('input[name="schedule-type"]:checked').value;
  const entry = {
    id: editingScheduleId || undefined,
    title: document.getElementById('schedule-title-input').value.trim(),
    subject: document.getElementById('schedule-subject-select').value || undefined,
    category: document.getElementById('schedule-category-input').value.trim() || undefined,
    type,
    dayOfWeek: type === 'weekly' ? Number(document.getElementById('schedule-day-select').value) : undefined,
    date: type === 'once' ? document.getElementById('schedule-date-input').value : undefined,
    startTime: document.getElementById('schedule-start-input').value,
    endTime: document.getElementById('schedule-end-input').value || undefined,
    location: document.getElementById('schedule-location-input').value.trim() || undefined,
    teacher: document.getElementById('schedule-teacher-input').value.trim() || undefined,
    notifyMinutesBefore: Number(document.getElementById('schedule-notify-select').value),
  };
  if (!entry.title || !entry.startTime) return;
  await window.lectureApp.saveScheduleEntry(entry);
  closeScheduleModal();
  openCalendar();
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
  // The 'welcome' step (this function's only caller) is now only ever
  // shown on a genuine first run - see initOnboarding - so there's nothing
  // left to branch on here.
  showOnboardingStep('api-key');
}

document.getElementById('welcome-next-btn').addEventListener('click', proceedFromWelcome);

document.querySelector('.onboarding-skip').addEventListener('click', () => dismissOnboarding());

document.getElementById('onboarding-save-btn').addEventListener('click', async () => {
  const key = document.getElementById('onboarding-key-input').value.trim();
  const errorEl = document.getElementById('onboarding-error');
  if (!key) {
    errorEl.textContent = t('onboarding.apiKey.needKey');
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
  checkCloudflareApiStatus();
  if (apiKeyAlreadyConfigured) {
    // Nothing to set up and nothing to press - just a brief branded
    // flourish while the app itself finishes loading underneath, instead
    // of making a returning user look at (and sometimes reflexively
    // click) a "Начать" button that doesn't actually do anything for them.
    showOnboardingStep('splash');
    setTimeout(() => dismissOnboarding(), 950);
    return;
  }
  showOnboardingStep('welcome');
  welcomeAutoAdvanceTimer = setTimeout(proceedFromWelcome, 1700);
}

loadSettingsIntoForm();
initChat();
initOnboarding();
