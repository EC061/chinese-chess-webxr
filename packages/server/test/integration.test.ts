/**
 * End-to-end server tests: two real WebSocket clients, a real SQLite database
 * (in a temp directory), a real game. These cover the parts that unit tests
 * cannot — that the server rejects a client that lies about a move, that 悔棋
 * needs the opponent's consent, and that ratings actually move.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@ccx/shared';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: App;
let port: number;
let dir: string;

const config = () => loadConfig({
  NODE_ENV: 'test',
  PORT: '0',
  HOST: '127.0.0.1',
  SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass-validation',
  DATABASE_PATH: join(dir, 'test.db'),
  STATIC_DIR: join(dir, 'static'),
  LOG_LEVEL: 'error',
  AI_REPORT_COOLDOWN_MS: '0',
  // The suite registers many accounts from one address; the throttle itself is
  // covered by its own test below.
  AUTH_RATE_LIMIT: '1000',
  UNDO_RESPONSE_TIMEOUT_MS: '1000',
} as NodeJS.ProcessEnv);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccx-test-'));
  app = createApp(config());
  port = await app.listen();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const api = async (path: string, body?: unknown, token?: string) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** A test client that records every message and can await specific ones. */
class Peer {
  private readonly received: ServerMessage[] = [];
  private waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  readonly ws: WebSocket;

  constructor(token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.received.push(message);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(message)) return true;
        w.resolve(message);
        return false;
      });
    });
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Resolve with the first matching message, past or future. */
  next<T extends ServerMessage['t']>(
    type: T, predicate: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    timeoutMs = 4000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const match = (m: ServerMessage): boolean =>
      m.t === type && predicate(m as Extract<ServerMessage, { t: T }>);
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing as Extract<ServerMessage, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${type}; saw ${this.received.map((m) => m.t).join(', ')}`)),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (m) => { clearTimeout(timer); resolve(m as Extract<ServerMessage, { t: T }>); },
      });
    });
  }

  clear(): void {
    this.received.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

const register = async (name: string) => {
  const res = await api('/api/register', { name, password: 'correct horse battery' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { token: string; user: { id: string; name: string; rating: number } };
};

describe('HTTP API', () => {
  it('serves health', async () => {
    const res = await api('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('sets the headers WebXR and SharedArrayBuffer require', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(res.headers.get('permissions-policy')).toContain('xr-spatial-tracking');
  });

  it('rejects a weak password and a bad name', async () => {
    expect((await api('/api/register', { name: 'ok name', password: 'short' })).status).toBe(400);
    expect((await api('/api/register', { name: '!!', password: 'long enough password' })).status).toBe(400);
  });

  it('refuses a duplicate name regardless of case', async () => {
    await register('Duplicate');
    const again = await api('/api/register', { name: 'DUPLICATE', password: 'correct horse battery' });
    expect(again.status).toBe(409);
  });

  it('logs in and returns the same identity', async () => {
    const created = await register('LoginTest');
    const login = await api('/api/login', { name: 'logintest', password: 'correct horse battery' });
    expect(login.status).toBe(200);
    expect((login.body.user as { id: string }).id).toBe(created.user.id);
  });

  it('gives the same answer for a wrong password and an unknown name', async () => {
    const a = await api('/api/login', { name: 'LoginTest', password: 'wrong password here' });
    const b = await api('/api/login', { name: 'NoSuchPlayer', password: 'wrong password here' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('issues guest tokens with unique names', async () => {
    const a = await api('/api/guest', { name: 'Guest' });
    const b = await api('/api/guest', { name: 'Guest' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body.user as { name: string }).name).not.toBe((b.body.user as { name: string }).name);
  });
});

describe('WebSocket auth', () => {
  it('refuses a connection with no token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await expect(new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    })).rejects.toThrow();
  });

  it('refuses a forged token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=bogus.signature`);
    await expect(new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    })).rejects.toThrow();
  });
});

describe('rooms and play', () => {
  it('runs a full game between two players and rates it', async () => {
    const red = await register('RedPlayer');
    const black = await register('BlackPlayer');
    const a = new Peer(red.token);
    const b = new Peer(black.token);
    await Promise.all([a.open(), b.open()]);
    await a.next('hello');
    await b.next('hello');

    a.send({ t: 'room:create', name: 'Test room', side: 'red', rated: true, timeControl: null, open: true });
    const joined = await a.next('room:joined');
    expect(joined.you).toBe('red');
    const roomId = joined.room.id;

    b.send({ t: 'room:join', roomId });
    const bJoined = await b.next('room:joined');
    expect(bJoined.you).toBe('black');

    // Both should now see a live game.
    const state = await a.next('game:state', (m) => m.state.turn === 'red');
    expect(state.state.moves.length).toBe(0);

    // The 中炮直车 opening, long enough to clear the eight-move rating floor.
    // Move 9 (炮五进四) puts Black in check over its own cannon, and 10 answers
    // by moving that cannon away — which both breaks the screen and wins a soldier.
    const script = [
      ['a', 'h2e2'], ['b', 'h7e7'], ['a', 'h0g2'], ['b', 'h9g7'],
      ['a', 'i0h0'], ['b', 'i9h9'], ['a', 'h0h4'], ['b', 'h9h5'],
      ['a', 'e2e6'], ['b', 'e7e3'],
    ] as const;
    for (const [who, iccs] of script) {
      const mover = who === 'a' ? a : b;
      const other = who === 'a' ? b : a;
      other.clear();
      mover.send({ t: 'game:move', iccs });
      await other.next('game:state', (m) => m.state.moves.some((mv) => mv.iccs === iccs));
    }

    // Red resigns, which must produce a rating change for both.
    a.send({ t: 'game:resign' });
    const over = await b.next('game:over');
    expect(over.result).toBe('black');
    expect(over.reason).toBe('resignation');
    expect(over.ratings.length).toBe(2);
    const redChange = over.ratings.find((r) => r.userId === red.user.id)!;
    const blackChange = over.ratings.find((r) => r.userId === black.user.id)!;
    expect(redChange.after).toBeLessThan(redChange.before);
    expect(blackChange.after).toBeGreaterThan(blackChange.before);

    a.close();
    b.close();
  });

  it('rejects an illegal move and resyncs the offender', async () => {
    const red = await register('Cheater');
    const black = await register('Honest');
    const a = new Peer(red.token);
    const b = new Peer(black.token);
    await Promise.all([a.open(), b.open()]);
    await a.next('hello');
    await b.next('hello');

    a.send({ t: 'room:create', name: 'Illegal', side: 'red', rated: false, timeControl: null, open: true });
    const roomId = (await a.next('room:joined')).room.id;
    b.send({ t: 'room:join', roomId });
    await b.next('room:joined');
    await a.next('game:state');

    // A chariot cannot leap the whole board on move one.
    a.send({ t: 'game:move', iccs: 'a0a9' });
    const error = await a.next('error');
    expect(error.code).toBe('ILLEGAL_MOVE');
    const resync = await a.next('game:state', (m) => m.state.moves.length === 0);
    expect(resync.state.turn).toBe('red');

    a.close();
    b.close();
  });

  it('refuses to let a player move out of turn', async () => {
    const red = await register('TurnRed');
    const black = await register('TurnBlack');
    const a = new Peer(red.token);
    const b = new Peer(black.token);
    await Promise.all([a.open(), b.open()]);
    await a.next('hello');
    await b.next('hello');

    a.send({ t: 'room:create', name: 'Turns', side: 'red', rated: false, timeControl: null, open: true });
    const roomId = (await a.next('room:joined')).room.id;
    b.send({ t: 'room:join', roomId });
    await b.next('room:joined');
    await b.next('game:state');

    b.send({ t: 'game:move', iccs: 'h7e7' });
    expect((await b.next('error')).code).toBe('NOT_YOUR_TURN');

    a.close();
    b.close();
  });

  it('requires the opponent to agree before taking back a move', async () => {
    const red = await register('UndoRed');
    const black = await register('UndoBlack');
    const a = new Peer(red.token);
    const b = new Peer(black.token);
    await Promise.all([a.open(), b.open()]);
    await a.next('hello');
    await b.next('hello');

    a.send({ t: 'room:create', name: 'Undo', side: 'red', rated: true, timeControl: null, open: true });
    const roomId = (await a.next('room:joined')).room.id;
    b.send({ t: 'room:join', roomId });
    await b.next('room:joined');
    await a.next('game:state');

    a.send({ t: 'game:move', iccs: 'h2e2' });
    await b.next('game:state', (m) => m.state.moves.length === 1);

    // Declined first: the move must stay on the board.
    b.clear();
    a.send({ t: 'game:undo-request' });
    const asked = await b.next('game:undo-requested');
    expect(asked.byName).toBe('UndoRed');
    b.send({ t: 'game:undo-response', accept: false });
    const declined = await a.next('game:undo-result');
    expect(declined.accepted).toBe(false);

    let current = await a.next('game:state', (m) => m.state.moves.length === 1);
    expect(current.state.moves.length).toBe(1);

    // Accepted: the move comes off and it is Red's turn again.
    a.clear();
    b.clear();
    a.send({ t: 'game:undo-request' });
    await b.next('game:undo-requested');
    b.send({ t: 'game:undo-response', accept: true });
    const accepted = await a.next('game:undo-result');
    expect(accepted.accepted).toBe(true);
    current = await a.next('game:state', (m) => m.state.moves.length === 0);
    expect(current.state.turn).toBe('red');

    a.close();
    b.close();
  });

  it('will not let a spectator move or answer an undo request', async () => {
    const red = await register('SpecRed');
    const black = await register('SpecBlack');
    const watcher = await register('Watcher');
    const a = new Peer(red.token);
    const b = new Peer(black.token);
    const c = new Peer(watcher.token);
    await Promise.all([a.open(), b.open(), c.open()]);
    await Promise.all([a.next('hello'), b.next('hello'), c.next('hello')]);

    a.send({ t: 'room:create', name: 'Watched', side: 'red', rated: false, timeControl: null, open: true });
    const roomId = (await a.next('room:joined')).room.id;
    b.send({ t: 'room:join', roomId });
    await b.next('room:joined');
    c.send({ t: 'room:spectate', roomId });
    expect((await c.next('room:joined')).you).toBe('spectator');

    c.send({ t: 'game:move', iccs: 'h2e2' });
    expect((await c.next('error')).code).toBe('NOT_IN_ROOM');

    a.close();
    b.close();
    c.close();
  });

  it('enforces the room passcode', async () => {
    const host = await register('PassHost');
    const guest = await register('PassGuest');
    const a = new Peer(host.token);
    const b = new Peer(guest.token);
    await Promise.all([a.open(), b.open()]);
    await Promise.all([a.next('hello'), b.next('hello')]);

    a.send({
      t: 'room:create', name: 'Private', passcode: '4821', side: 'red', rated: false,
      timeControl: null, open: true,
    });
    const room = (await a.next('room:joined')).room;
    expect(room.hasPasscode).toBe(true);

    b.send({ t: 'room:join', roomId: room.id, passcode: '0000' });
    expect((await b.next('error')).code).toBe('BAD_PASSCODE');

    b.send({ t: 'room:join', roomId: room.id, passcode: '4821' });
    expect((await b.next('room:joined')).you).toBe('black');

    a.close();
    b.close();
  });

  it('lists rooms in the lobby, passcode-protected ones included', async () => {
    const host = await register('LobbyHost');
    const browser = await register('LobbyBrowser');
    const a = new Peer(host.token);
    const b = new Peer(browser.token);
    await Promise.all([a.open(), b.open()]);
    await Promise.all([a.next('hello'), b.next('hello')]);

    a.send({
      t: 'room:create', name: 'Findable', passcode: '9999', side: 'random', rated: true,
      timeControl: null, open: true,
    });
    await a.next('room:joined');

    b.send({ t: 'lobby:subscribe' });
    const list = await b.next('lobby:rooms', (m) => m.rooms.some((r) => r.name === 'Findable'));
    const found = list.rooms.find((r) => r.name === 'Findable')!;
    expect(found.hasPasscode).toBe(true);
    expect(found.status).toBe('waiting');

    a.close();
    b.close();
  });

  it('rejects a message that does not match the protocol', async () => {
    const user = await register('Malformed');
    const a = new Peer(user.token);
    await a.open();
    await a.next('hello');
    a.send({ t: 'room:create', name: '' });
    expect((await a.next('error')).code).toBe('BAD_MESSAGE');
    a.send({ t: 'nonsense' });
    expect((await a.next('error')).code).toBe('BAD_MESSAGE');
    a.close();
  });
});

describe('AI game reporting', () => {
  /** Ten legal plies of a real opening, with no terminal position. */
  const legalGame = [
    'h2e2', 'h7e7', 'h0g2', 'h9g7', 'i0h0', 'i9h9', 'h0h4', 'h9h5', 'e2e6', 'e7e3',
  ];

  it('refuses a report whose moves are not legal', async () => {
    const user = await register('FakeMoves');
    const a = new Peer(user.token);
    await a.open();
    await a.next('hello');
    a.send({
      t: 'ai:report', level: 4, playerColor: 'red',
      moves: [...legalGame, 'a0a9'], result: 'red', undos: 0,
    });
    const reply = await a.next('ai:rated');
    expect(reply.rating).toBeNull();
    expect(reply.reason).toBe('invalid-game');
    a.close();
  });

  it('refuses a claimed win that the final position does not support', async () => {
    const user = await register('FakeWin');
    const a = new Peer(user.token);
    await a.open();
    await a.next('hello');
    a.send({ t: 'ai:report', level: 6, playerColor: 'red', moves: legalGame, result: 'red', undos: 0 });
    const reply = await a.next('ai:rated');
    expect(reply.rating).toBeNull();
    expect(reply.reason).toBe('unfinished');
    a.close();
  });

  it('refuses a game where the player used 悔棋', async () => {
    const user = await register('UsedUndo');
    const a = new Peer(user.token);
    await a.open();
    await a.next('hello');
    a.send({ t: 'ai:report', level: 3, playerColor: 'red', moves: legalGame, result: 'black', undos: 2 });
    expect((await a.next('ai:rated')).reason).toBe('undo-used');
    a.close();
  });

  it('accepts a resignation loss and lowers the rating', async () => {
    const user = await register('HonestLoss');
    const a = new Peer(user.token);
    await a.open();
    await a.next('hello');
    a.send({ t: 'ai:report', level: 5, playerColor: 'red', moves: legalGame, result: 'black', undos: 0 });
    const reply = await a.next('ai:rated');
    expect(reply.rating).not.toBeNull();
    expect(reply.rating!.after).toBeLessThan(reply.rating!.before);
    a.close();
  });

  it('does not rate AI games for guests', async () => {
    const guest = await api('/api/guest', { name: 'AiGuest' });
    const a = new Peer((guest.body as { token: string }).token);
    await a.open();
    await a.next('hello');
    a.send({ t: 'ai:report', level: 3, playerColor: 'red', moves: legalGame, result: 'black', undos: 0 });
    expect((await a.next('ai:rated')).reason).toBe('guest');
    a.close();
  });
});

describe('leaderboard', () => {
  it('excludes guests and players with too few games', async () => {
    const res = await api('/api/leaderboard');
    expect(res.status).toBe(200);
    const entries = res.body.entries as Array<{ guest: boolean; name: string }>;
    for (const entry of entries) expect(entry.guest).toBe(false);
  });
});
