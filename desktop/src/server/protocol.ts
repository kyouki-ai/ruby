// Message shapes exchanged over the local WebSocket between the browser
// extension (client) and the desktop app (server). Keep this in sync with
// the plain-JS mirror the extension uses (it can't import TS directly).

export interface HelloMessage {
  type: 'hello';
  tabUrl: string;
  tabTitle: string;
}

export interface AudioChunkMessage {
  type: 'audio-chunk';
  // Offset from session start, in seconds.
  startOffsetSec: number;
  durationSec: number;
  // Base64-encoded 16-bit PCM, mono, 16kHz.
  pcmBase64: string;
}

export interface SlideMessage {
  type: 'slide';
  offsetSec: number;
  url: string;
  title: string;
  // innerText of the page at capture time, may be empty for canvas-based slides.
  text: string;
  // Base64-encoded JPEG screenshot of the visible tab.
  screenshotBase64: string;
}

export interface StopMessage {
  type: 'stop';
}

// A lightweight, always-on connection the extension's background service
// worker keeps open (separate from the audio-streaming socket, which only
// exists during an actual recording) so the desktop app can tell it to
// start capturing without the user opening the popup themselves.
export interface ExtensionReadyMessage {
  type: 'extension-ready';
}

export type ClientMessage = HelloMessage | AudioChunkMessage | SlideMessage | StopMessage | ExtensionReadyMessage;

export interface ServerAckMessage {
  type: 'hello-ack';
  connected: true;
}

export interface ServerErrorMessage {
  type: 'error';
  message: string;
}

/** Sent down the control channel to make the extension start recording on its own. */
export interface RemoteStartMessage {
  type: 'remote-start';
  mode: 'tab-slides' | 'tab-audio-only';
}

/** Sent down the control channel to make the extension stop an in-progress recording. */
export interface RemoteStopMessage {
  type: 'remote-stop';
}

export type ServerMessage = ServerAckMessage | ServerErrorMessage | RemoteStartMessage | RemoteStopMessage;
