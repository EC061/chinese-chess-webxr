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
  /**
   * Repeated handshakes that never open. Usually Wi-Fi, but it is also what an
   * expired or cleared session looks like from down here — the server rejects
   * the upgrade and the socket closes without a word. The store re-checks the
   * session rather than leaving the player watching "Reconnecting…" forever.
   */
  onStalled(): void;
}

const MAX_BACKOFF_MS = 15_000;
/** Consecutive failed handshakes before the session itself is suspect. */
const STALLED_AFTER = 5;

export class Net {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private closedByUs = false;
  private queue: ClientMessage[] = [];
  private state: ConnectionState = 'idle';
  /** Whether this socket ever reached OPEN, to tell rejection from a drop. */
  private opened = false;
  /** Replayed after a reconnect so the session picks up where it left off. */
  private resume: ClientMessage[] = [];

  constructor(private readonly handlers: NetHandlers) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUs = false;
    this.attempt = 0;
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
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');

    // No token in the URL: the handshake carries the session cookie, which keeps
    // a long-lived credential out of proxy and access logs.
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.opened = true;
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
      if (!this.opened && this.attempt % STALLED_AFTER === 0) this.handlers.onStalled();
      this.timer = window.setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => {
      // onclose always follows, which is where the retry lives.
    };
  }
}
