/**
 * WebSocket transport. Auto-reconnects with backoff, and re-announces whatever
 * the UI was doing (browsing the lobby, or sitting in a room) once it is back —
 * headsets drop Wi-Fi often enough that this is not optional.
 */
import type { ClientMessage, ServerMessage } from '@ccx/shared';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface NetHandlers {
  onMessage(message: ServerMessage): void;
  onState(state: ConnectionState): void;
}

const MAX_BACKOFF_MS = 15_000;

export class Net {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private closedByUs = false;
  private queue: ClientMessage[] = [];
  private state: ConnectionState = 'idle';
  /** Replayed after a reconnect so the session picks up where it left off. */
  private resume: ClientMessage[] = [];

  constructor(private readonly handlers: NetHandlers) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(token: string): void {
    this.token = token;
    this.closedByUs = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.ws?.close(1000, 'client closed');
    this.ws = null;
    this.resume = [];
    this.setState('closed');
  }

  /**
   * Messages worth replaying after a reconnect. Room membership and lobby
   * subscription are the two bits of state the server does not remember for us.
   */
  setResumeIntent(messages: ClientMessage[]): void {
    this.resume = messages;
  }

  send(message: ClientMessage): void {
    if (this.connected) {
      this.ws!.send(JSON.stringify(message));
      return;
    }
    // Hold non-streaming messages; presence updates are worthless when stale.
    if (message.t !== 'room:pose' && message.t !== 'game:grab') this.queue.push(message);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState(state);
  }

  private open(): void {
    if (!this.token) return;
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      for (const message of this.resume) ws.send(JSON.stringify(message));
      const pending = this.queue;
      this.queue = [];
      for (const message of pending) ws.send(JSON.stringify(message));
    };

    ws.onmessage = (event) => {
      try {
        this.handlers.onMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        // A message we cannot parse is a bug on one side; dropping it is better
        // than tearing down a live game.
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUs) { this.setState('closed'); return; }
      this.setState('reconnecting');
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt) * (0.7 + Math.random() * 0.6);
      this.attempt++;
      this.timer = window.setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => {
      // onclose always follows, which is where the retry lives.
    };
  }
}
