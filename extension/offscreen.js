// Runs in the extension's hidden offscreen document - the only MV3 context
// that can hold a live MediaStream and a long-lived WebSocket at the same
// time (the background service worker can be killed mid-stream).

// Free-tier Gemini quotas are tight (as low as ~10 RPM and a few hundred
// requests/day) - one call every 12s would burn through a whole day's quota
// in under an hour. Longer chunks trade some "live" immediacy for actually
// lasting a full day of lectures.
const CHUNK_DURATION_SEC = 30;
const TARGET_SAMPLE_RATE = 16000; // whisper.cpp expects 16kHz mono PCM16
const RECONNECT_DELAY_MS = 3000;

let ws = null;
let audioContext = null;
let mediaStream = null;
let processorNode = null;
let slideIntervalId = null;

let sessionStartTime = 0;
let chunkStartOffsetSec = 0;
let pcmBuffer = []; // array of Int16Array pieces accumulated for the current chunk
let pcmBufferedSamples = 0;

let capturing = false;
let sessionInfo = { tabUrl: '', tabTitle: '' };
const pendingMessages = []; // queued while the socket is reconnecting

function connectWebSocket(wsUrl) {
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    chrome.runtime.sendMessage({ type: 'ws-status', connected: true });
    sendOrQueue({ type: 'hello', tabUrl: sessionInfo.tabUrl, tabTitle: sessionInfo.tabTitle });
    flushPending();
  });

  ws.addEventListener('close', () => {
    chrome.runtime.sendMessage({ type: 'ws-status', connected: false });
    if (capturing) setTimeout(() => connectWebSocket(wsUrl), RECONNECT_DELAY_MS);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

function sendOrQueue(message) {
  const payload = JSON.stringify(message);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
  } else {
    pendingMessages.push(payload);
  }
}

function flushPending() {
  while (pendingMessages.length > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(pendingMessages.shift());
  }
}

/** Naive linear-interpolation resampler; good enough for speech at 16kHz. */
function downsampleTo16k(float32Samples, inputSampleRate) {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return float32Samples;
  }
  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
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

function floatTo16BitPCM(float32Samples) {
  const out = new Int16Array(float32Samples.length);
  for (let i = 0; i < float32Samples.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ArrayToBase64(chunks) {
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

function flushAudioChunk() {
  if (pcmBufferedSamples === 0) return;
  const pcmBase64 = int16ArrayToBase64(pcmBuffer);
  const durationSec = pcmBufferedSamples / TARGET_SAMPLE_RATE;

  sendOrQueue({
    type: 'audio-chunk',
    startOffsetSec: chunkStartOffsetSec,
    durationSec,
    pcmBase64,
  });

  chunkStartOffsetSec += durationSec;
  pcmBuffer = [];
  pcmBufferedSamples = 0;
}

async function startCapture(msg) {
  capturing = true;
  sessionStartTime = Date.now();
  chunkStartOffsetSec = 0;
  sessionInfo = { tabUrl: msg.tabUrl, tabTitle: msg.tabTitle };

  connectWebSocket(msg.wsUrl);

  audioContext = new AudioContext();
  // A freshly created AudioContext can start life 'suspended' (autoplay
  // policy) - without resuming, onaudioprocess below never fires.
  await audioContext.resume();

  // ScriptProcessorNode is deprecated but remains the simplest cross-version
  // way to get raw PCM frames without bundling an AudioWorklet module file.
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  processorNode.connect(audioContext.destination);
  processorNode.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16k(input, audioContext.sampleRate);
    const pcm16 = floatTo16BitPCM(downsampled);
    pcmBuffer.push(pcm16);
    pcmBufferedSamples += pcm16.length;

    if (pcmBufferedSamples / TARGET_SAMPLE_RATE >= CHUNK_DURATION_SEC) {
      flushAudioChunk();
    }
  };

  // Note: mixing in the microphone here was tried and removed - a hidden
  // offscreen document can never show the user a permission prompt, so
  // getUserMedia({audio: true}) reliably fails with a DOMException in this
  // context. Microphone recording lives in the desktop app itself instead
  // (a normal window, which *can* prompt for permission).
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: msg.streamId,
      },
    },
  });
  const source = audioContext.createMediaStreamSource(mediaStream);
  // Keep the lecture audible to the user - capturing the tab mutes it otherwise.
  source.connect(audioContext.destination);
  source.connect(processorNode);

  if (msg.needsSlides) {
    slideIntervalId = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'request-slide-capture' });
    }, msg.slideIntervalSec * 1000);
  }
}

function stopCapture() {
  capturing = false;
  flushAudioChunk();
  sendOrQueue({ type: 'stop' });

  clearInterval(slideIntervalId);
  slideIntervalId = null;

  processorNode?.disconnect();
  audioContext?.close();
  mediaStream?.getTracks().forEach((track) => track.stop());

  setTimeout(() => ws?.close(), 200); // give the 'stop' message time to flush
}

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'start-capture':
      startCapture(message).catch((err) => {
        console.error('Failed to start capture:', err);
        capturing = false;
        chrome.runtime.sendMessage({ type: 'capture-failed', message: String(err) });
      });
      break;
    case 'stop-capture':
      stopCapture();
      break;
    case 'slide-captured': {
      const offsetSec = (Date.now() - sessionStartTime) / 1000;
      sendOrQueue({
        type: 'slide',
        offsetSec,
        url: message.url,
        title: message.title,
        text: message.text,
        screenshotBase64: message.screenshotBase64,
      });
      break;
    }
    default:
      break;
  }
});
