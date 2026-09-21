// MV3 service worker. It cannot touch media streams or WebSockets directly
// (the worker can be killed at any time), so actual capture happens in an
// "offscreen" document (offscreen.html/js) that this file creates and talks
// to via chrome.runtime messaging.

const WS_PORT = 8787; // must match desktop/src/config.ts WS_PORT
const WS_URL = `ws://localhost:${WS_PORT}`;
const SLIDE_INTERVAL_SEC = 25;

const state = {
  capturing: false,
  wsConnected: false,
  activeTabId: null,
  mode: null,
};

// This worker can be evicted and restarted at any time (routinely after
// ~30s idle) even mid-recording, which used to reset `state` back to its
// defaults while the offscreen document kept right on capturing - silently
// breaking slide screenshots (wrong/missing activeTabId) and remote-stop
// (see the control-channel handler below) without anything actually
// crashing. `chrome.storage.session` survives a worker restart within the
// same browser session, so a fresh worker can recover what it was doing.
function persistCaptureState() {
  chrome.storage.session.set({
    capturing: state.capturing,
    activeTabId: state.activeTabId,
    mode: state.mode,
  });
}
chrome.storage.session.get(['capturing', 'activeTabId', 'mode']).then((saved) => {
  Object.assign(state, saved);
});

// Always-on control connection to the desktop app (separate from the
// audio-streaming socket the offscreen document opens only while actually
// recording), so the app can tell this extension to start capturing without
// the user opening this popup themselves.
let controlWs = null;

function connectControlChannel() {
  if (controlWs && (controlWs.readyState === WebSocket.OPEN || controlWs.readyState === WebSocket.CONNECTING)) return;

  controlWs = new WebSocket(WS_URL);
  controlWs.addEventListener('open', () => {
    controlWs.send(JSON.stringify({ type: 'extension-ready' }));
  });
  controlWs.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    // Gating on `state.capturing` used to mean a stop/start silently no-op'd
    // whenever the background service worker had been evicted and restarted
    // mid-recording (routine after ~30s idle) - a fresh worker's `state`
    // resets to its defaults even though the offscreen document is still
    // actually capturing, so `state.capturing` no longer reflects reality.
    // `chrome.offscreen.hasDocument()` asks the real thing instead of this
    // worker's possibly-stale memory of it.
    if (msg.type === 'remote-start') {
      chrome.offscreen.hasDocument().then((alreadyCapturing) => {
        if (!alreadyCapturing) startCapture(msg.mode).catch((err) => console.error('Remote start failed:', err));
      });
    }
    if (msg.type === 'remote-stop') {
      chrome.offscreen.hasDocument().then((capturing) => {
        if (capturing) stopCapture().catch((err) => console.error('Remote stop failed:', err));
      });
    }
  });
  // Short retry - a dropped control connection should look "instant" to
  // someone watching the desktop app's recording screen, not "broken".
  controlWs.addEventListener('close', () => setTimeout(connectControlChannel, 1000));
  controlWs.addEventListener('error', () => controlWs.close());
}

connectControlChannel();
// The desktop app is the source of truth for "is the extension reachable
// right now" - a service worker can be evicted after ~30s idle, so these
// wake it back up and re-open the control channel on a regular cadence.
chrome.runtime.onStartup.addListener(connectControlChannel);
chrome.runtime.onInstalled.addListener(connectControlChannel);
chrome.alarms.create('control-channel-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'control-channel-keepalive') connectControlChannel();
});

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'status-update', status: { ...state } }).catch(() => {
    // No listener open (popup closed) - fine to ignore.
  });
}

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for speech-to-text transcription.',
  });
}

// Two capture modes, picked in the popup:
// - 'tab-slides':      tab audio, plus periodic slide screenshots/text
// - 'tab-audio-only':  tab audio only, no slide capture
// (Microphone-only, offline-lecture recording lives in the desktop app
// itself - a hidden offscreen document can never show a permission prompt,
// so getUserMedia(mic) from here reliably fails.)
async function startCapture(mode) {
  const needsSlides = mode === 'tab-slides';

  // Not `currentWindow: true` - that resolves relative to the calling
  // script's own window, which is undefined for a service worker (it has no
  // window). Remote-start arrives here from the desktop app's control
  // channel, not from the popup, so there is no "current window" to speak
  // of - `lastFocusedWindow` is the well-defined way to mean "whichever
  // browser window/tab the user was last looking at" regardless of who
  // triggered this call, including from a background context.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  await ensureOffscreenDocument();

  state.activeTabId = needsSlides ? tab.id : null;
  state.capturing = true;
  state.mode = mode;
  state.error = null;
  persistCaptureState();

  await chrome.runtime.sendMessage({
    type: 'start-capture',
    streamId,
    needsSlides,
    wsUrl: WS_URL,
    tabUrl: tab.url ?? '',
    tabTitle: tab.title ?? 'Lecture',
    slideIntervalSec: SLIDE_INTERVAL_SEC,
  });
}

async function stopCapture() {
  state.capturing = false;
  state.wsConnected = false;
  state.activeTabId = null;
  state.mode = null;
  persistCaptureState();

  try {
    await chrome.runtime.sendMessage({ type: 'stop-capture' });
  } catch {
    // Offscreen doc may already be gone.
  }
  if (await chrome.offscreen.hasDocument?.()) {
    await chrome.offscreen.closeDocument();
  }
}

async function captureSlideForActiveTab() {
  if (!state.capturing || !state.activeTabId) return;

  try {
    const tab = await chrome.tabs.get(state.activeTabId);
    const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 60,
    });
    const screenshotBase64 = screenshotDataUrl.split(',')[1] ?? '';

    const [{ result: text } = {}] = await chrome.scripting.executeScript({
      target: { tabId: state.activeTabId },
      func: () => document.body.innerText.slice(0, 8000),
    });

    await chrome.runtime.sendMessage({
      type: 'slide-captured',
      url: tab.url ?? '',
      title: tab.title ?? '',
      text: text ?? '',
      screenshotBase64,
    });
  } catch (err) {
    console.warn('Slide capture failed (tab may not be capturable):', err);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'popup-start':
      startCapture(message.mode)
        .then(() => sendResponse({ ...state }))
        .catch((err) => {
          console.error('Failed to start capture:', err);
          state.capturing = false;
          sendResponse({ ...state, error: String(err) });
        });
      return true; // keep sendResponse alive for the async work above

    case 'popup-stop':
      stopCapture().then(() => sendResponse({ ...state }));
      return true;

    case 'get-status':
      sendResponse({ ...state });
      return false;

    case 'ws-status':
      state.wsConnected = message.connected;
      broadcastStatus();
      return false;

    case 'capture-failed':
      state.capturing = false;
      state.wsConnected = false;
      state.activeTabId = null;
      state.mode = null;
      state.error = message.message;
      persistCaptureState();
      broadcastStatus();
      if (chrome.offscreen.hasDocument) {
        chrome.offscreen.hasDocument().then((has) => has && chrome.offscreen.closeDocument());
      }
      return false;

    case 'request-slide-capture':
      void captureSlideForActiveTab();
      return false;

    default:
      return false;
  }
});
