import { WebSocketServer, WebSocket } from 'ws';
import { WS_PORT } from '../config';
import type { ClientMessage, ServerMessage } from './protocol';

export interface LectureSession {
  tabUrl: string;
  tabTitle: string;
  startedAt: number;
}

export interface WsServerEvents {
  onConnected: (session: LectureSession) => void;
  onDisconnected: () => void;
  onAudioChunk: (msg: Extract<ClientMessage, { type: 'audio-chunk' }>) => void;
  onSlide: (msg: Extract<ClientMessage, { type: 'slide' }>) => void;
  onStop: () => void;
  /** Whether the extension's always-on control channel is connected right now. */
  onExtensionReady: (ready: boolean) => void;
}

/**
 * Local-only WebSocket server the browser extension connects to. Two kinds
 * of connections share the same port: the "control" channel (always-on,
 * lets the desktop app tell the extension to start recording on its own)
 * and the "recording" session (the actual audio/slide stream, only while a
 * lecture is being captured - one at a time).
 */
export class WsServer {
  private wss: WebSocketServer | null = null;
  private activeSocket: WebSocket | null = null;
  private controlSocket: WebSocket | null = null;

  constructor(private events: WsServerEvents) {}

  start(): void {
    this.wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

    // Without this, a bind failure (e.g. the port is still held by a process
    // that hasn't fully exited yet) throws an uncaught exception and takes
    // down the whole app instead of just failing to accept connections.
    this.wss.on('error', (err) => {
      console.error('WebSocket server error:', err);
    });

    this.wss.on('connection', (socket) => {
      // Which kind of connection this is isn't known until its first
      // message ('hello' vs 'extension-ready') - see handleMessage.
      socket.on('message', (data) => this.handleMessage(socket, data.toString()));

      socket.on('close', () => this.handleSocketGone(socket));
      socket.on('error', () => this.handleSocketGone(socket));
    });
  }

  stop(): void {
    this.activeSocket?.close();
    this.controlSocket?.close();
    this.wss?.close();
    this.wss = null;
  }

  isExtensionReady(): boolean {
    return this.controlSocket?.readyState === WebSocket.OPEN;
  }

  /** Tells the extension to start recording on its own - returns false if it isn't connected. */
  sendRemoteStart(mode: 'tab-slides' | 'tab-audio-only'): boolean {
    if (!this.isExtensionReady()) return false;
    this.send(this.controlSocket!, { type: 'remote-start', mode });
    return true;
  }

  /** Tells the extension to stop an in-progress recording - returns false if it isn't connected. */
  sendRemoteStop(): boolean {
    if (!this.isExtensionReady()) return false;
    this.send(this.controlSocket!, { type: 'remote-stop' });
    return true;
  }

  private handleSocketGone(socket: WebSocket): void {
    if (this.activeSocket === socket) {
      this.activeSocket = null;
      this.events.onDisconnected();
    }
    if (this.controlSocket === socket) {
      this.controlSocket = null;
      this.events.onExtensionReady(false);
    }
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(socket, { type: 'error', message: 'Malformed JSON message' });
      return;
    }

    switch (msg.type) {
      case 'extension-ready':
        this.controlSocket = socket;
        this.events.onExtensionReady(true);
        break;
      case 'hello':
        // Only one extension tab should stream audio at a time; reject extras.
        if (this.activeSocket && this.activeSocket !== socket) {
          this.send(socket, { type: 'error', message: 'Another lecture session is already active' });
          socket.close(1013, 'Another lecture session is already active');
          return;
        }
        this.activeSocket = socket;
        this.events.onConnected({
          tabUrl: msg.tabUrl,
          tabTitle: msg.tabTitle,
          startedAt: Date.now(),
        });
        this.send(socket, { type: 'hello-ack', connected: true });
        break;
      case 'audio-chunk':
        this.events.onAudioChunk(msg);
        break;
      case 'slide':
        this.events.onSlide(msg);
        break;
      case 'stop':
        this.events.onStop();
        break;
      default:
        this.send(socket, { type: 'error', message: `Unknown message type` });
    }
  }

  private send(socket: WebSocket, msg: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }
}
