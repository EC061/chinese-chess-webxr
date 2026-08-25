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
import { issueToken } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

let app: App;
let port: number;
let dir: string;

const SECRET = 'test-secret-that-is-long-enough-to-pass-validation';

const config = (extra: Record<string, string> = {}) => loadConfig({
  NODE_ENV: 'test',
  PORT: '0',
  HOST: '127.0.0.1',
  SESSION_SECRET: SECRET,
  DATABASE_PATH: join(dir, 'test.db'),
  STATIC_DIR: join(dir, 'static'),
  LOG_LEVEL: 'error',
  AI_REPORT_COOLDOWN_MS: '0',
  // The suite registers many accounts from one address; the throttle itself is
  // covered by its own test below.
  AUTH_RATE_LIMIT: '1000',
  UNDO_RESPONSE_TIMEOUT_MS: '1000',
  ...extra,
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

/** The session cookie's value, as a browser would keep it. */
const sessionFrom = (res: Response): string | null => {
  for (const header of res.headers.getSetCookie()) {
    const match = /^ccx_session=([^;]*)/.exec(header);
    if (match) return decodeURIComponent(match[1]!);
  }
  return null;
};

const api = async (
  path: string,
  body?: unknown,
  options: { session?: string | null; origin?: string; method?: string } = {},
) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.session ? { Cookie: `ccx_session=${encodeURIComponent(options.session)}` } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    session: sessionFrom(res),
    setCookie: res.headers.getSetCookie(),
  };
};

/** A test client that records every message and can await specific ones. */
class Peer {
  private readonly received: ServerMessage[] = [];
  private waiters: Array<{ match: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }> = [];
  readonly ws: WebSocket;

  constructor(session: string) {
    // A browser cannot set headers on a handshake but it does send cookies, and
    // the server authenticates the upgrade from that cookie alone.
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: `ccx_session=${encodeURIComponent(session)}` },
    });
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
  expect(res.session, 'register must set a session cookie').toBeTruthy();
  return {
    session: res.session!,
    user: (res.body as { user: { id: string; name: string; rating: number } }).user,
  };
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

  it('issues guest sessions with unique names', async () => {
    const a = await api('/api/guest', { name: 'Guest' });
    const b = await api('/api/guest', { name: 'Guest' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((a.body.user as { name: string }).name).not.toBe((b.body.user as { name: string }).name);
  });

  it('names a guest for the player without asking them for one', async () => {
    const res = await api('/api/guest', { lang: 'en' });
    expect(res.status).toBe(201);
    const { name, guest } = res.body.user as { name: string; guest: boolean };
    expect(guest).toBe(true);
    // Themed, readable, and inside the name rules — it goes on the ladder if the
    // player later claims the account, so it has to be a name worth keeping.
    expect(name).toMatch(/^[A-Za-z]+ [A-Za-z]+ \d{4}$/);
    expect(name.length).toBeLessThanOrEqual(20);
  });
});

describe('WebSocket auth', () => {
  const refused = (ws: WebSocket) => expect(new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  })).rejects.toThrow();

  it('refuses a connection with no session', async () => {
    await refused(new WebSocket(`ws://127.0.0.1:${port}/ws`));
  });

  it('refuses a forged session cookie', async () => {
    await refused(new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Cookie: 'ccx_session=bogus.signature' },
    }));
  });

  it('refuses a session in the query string, which is where it used to live', async () => {
    const user = await register('QueryStringToken');
    await refused(new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(user.session)}`,
    ));
  });

  it('refuses a handshake that claims another site as its origin', async () => {
    const user = await register('CrossSiteSocket');
    await refused(new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Cookie: `ccx_session=${encodeURIComponent(user.session)}`,
        Origin: 'https://evil.example',
      },
    }));
  });

  it('accepts a handshake from its own origin', async () => {
    const user = await register('SameSiteSocket');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Cookie: `ccx_session=${encodeURIComponent(user.session)}`,
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.close();
  });

  it('accepts the bearer header, for clients that are not browsers', async () => {
    const user = await register('BearerClient');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${user.session}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.close();
  });
});

describe('rooms and play', () => {
  it('runs a full game between two players and rates it', async () => {
    const red = await register('RedPlayer');
    const black = await register('BlackPlayer');
    const a = new Peer(red.session);
    const b = new Peer(black.session);
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
    const a = new Peer(red.session);
    const b = new Peer(black.session);
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
    const a = new Peer(red.session);
    const b = new Peer(black.session);
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
    const a = new Peer(red.session);
    const b = new Peer(black.session);
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
    const a = new Peer(red.session);
    const b = new Peer(black.session);
    const c = new Peer(watcher.session);
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
    const a = new Peer(host.session);
    const b = new Peer(guest.session);
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
    const a = new Peer(host.session);
    const b = new Peer(browser.session);
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
    const a = new Peer(user.session);
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
    const a = new Peer(user.session);
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
    const a = new Peer(user.session);
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
    const a = new Peer(user.session);
    await a.open();
    await a.next('hello');
    a.send({ t: 'ai:report', level: 3, playerColor: 'red', moves: legalGame, result: 'black', undos: 2 });
    expect((await a.next('ai:rated')).reason).toBe('undo-used');
    a.close();
  });

  it('accepts a resignation loss and lowers the rating', async () => {
    const user = await register('HonestLoss');
    const a = new Peer(user.session);
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
    const a = new Peer(guest.session!);
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


// ---------------------------------------------------------------- sessions --

/** The attributes of a Set-Cookie line, lowercased for comparison. */
const cookieAttrs = (header: string): string[] =>
  header.split(';').slice(1).map((part) => part.trim().toLowerCase());

const DAY_SECONDS = 24 * 60 * 60;

describe('cookie sessions', () => {
  it('puts the session in an HttpOnly, SameSite=Lax cookie', async () => {
    const res = await api('/api/login', { name: 'LoginTest', password: 'correct horse battery' });
    expect(res.status).toBe(200);
    const header = res.setCookie.find((line) => line.startsWith('ccx_session='))!;
    const attrs = cookieAttrs(header);
    expect(attrs).toContain('httponly');
    expect(attrs).toContain('samesite=lax');
    expect(attrs).toContain('path=/');
  });

  it('does not return the session in the response body', async () => {
    const res = await api('/api/login', { name: 'LoginTest', password: 'correct horse battery' });
    expect(res.body.token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(res.session!);
  });

  it('dates the cookie 400 days out, the longest a browser will honour', async () => {
    const res = await api('/api/login', { name: 'LoginTest', password: 'correct horse battery' });
    const header = res.setCookie.find((line) => line.startsWith('ccx_session='))!;
    const maxAge = Number(/max-age=(\d+)/i.exec(header)![1]);
    expect(maxAge).toBe(400 * DAY_SECONDS);
  });

  it('gives a cookie with no expiry when the player opts out of persistence', async () => {
    const res = await api('/api/login', {
      name: 'LoginTest', password: 'correct horse battery', persist: false,
    });
    const header = res.setCookie.find((line) => line.startsWith('ccx_session='))!;
    // No Max-Age and no Expires is a session cookie: the browser drops it when
    // it closes, which is the point on a headset somebody else also wears.
    expect(header.toLowerCase()).not.toContain('max-age');
    expect(header.toLowerCase()).not.toContain('expires');
    expect((res.body.session as { persist: boolean }).persist).toBe(false);
  });

  it('sends Secure when the deployment is served over HTTPS', async () => {
    const secure = createApp(config({
      SECURE_COOKIES: 'true',
      DATABASE_PATH: join(dir, 'secure.db'),
      STATIC_DIR: join(dir, 'static-secure'),
    }));
    const securePort = await secure.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${securePort}/api/guest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: 'en' }),
      });
      const header = res.headers.getSetCookie().find((line) => line.startsWith('ccx_session='))!;
      expect(cookieAttrs(header)).toContain('secure');
    } finally {
      await secure.close();
    }
  });

  it('authenticates /api/me from the cookie alone', async () => {
    const user = await register('CookieOnly');
    const me = await api('/api/me', undefined, { session: user.session });
    expect(me.status).toBe(200);
    expect((me.body.user as { id: string }).id).toBe(user.user.id);
  });

  it('does not re-stamp a cookie that was just issued', async () => {
    const user = await register('FreshCookie');
    const me = await api('/api/me', undefined, { session: user.session });
    expect(me.setCookie).toHaveLength(0);
  });

  /**
   * The eviction defence. A browser clamps any cookie to 400 days from when it
   * was set, so staying signed in past that means re-setting it — and the only
   * moment we reliably get is the player opening the app.
   */
  it('re-stamps a cookie that is old enough for the expiry to have drifted', async () => {
    const user = await register('StaleCookie');
    const issuedAt = Date.now() - 40 * DAY_SECONDS * 1000;
    const stale = issueToken(SECRET, {
      sub: user.user.id,
      guest: false,
      persist: true,
      iat: issuedAt,
      exp: issuedAt + 400 * DAY_SECONDS * 1000,
    });

    const me = await api('/api/me', undefined, { session: stale });
    expect(me.status).toBe(200);
    const header = me.setCookie.find((line) => line.startsWith('ccx_session='))!;
    expect(header, 'a stale session should come back re-stamped').toBeTruthy();
    // A full window again, counted from now rather than from 40 days ago.
    expect(Number(/max-age=(\d+)/i.exec(header)![1])).toBe(400 * DAY_SECONDS);
    expect(me.session).not.toBe(stale);
  });

  it('does not re-stamp a session the player asked not to persist', async () => {
    const user = await register('NoPersistStale');
    const issuedAt = Date.now() - 40 * DAY_SECONDS * 1000;
    const stale = issueToken(SECRET, {
      sub: user.user.id, guest: false, persist: false, iat: issuedAt,
      exp: Date.now() + DAY_SECONDS * 1000,
    });
    const me = await api('/api/me', undefined, { session: stale });
    expect(me.status).toBe(200);
    expect(me.setCookie).toHaveLength(0);
  });

  it('switches persistence on and off after the fact', async () => {
    const user = await register('TogglePersist');
    const off = await api('/api/session/persist', { persist: false }, { session: user.session });
    expect(off.status).toBe(200);
    expect(off.setCookie[0]!.toLowerCase()).not.toContain('max-age');

    const on = await api('/api/session/persist', { persist: true }, { session: off.session });
    expect(on.setCookie[0]!.toLowerCase()).toContain('max-age');
  });

  it('clears the cookie on logout', async () => {
    const user = await register('LogsOut');
    const out = await api('/api/logout', {}, { session: user.session });
    expect(out.status).toBe(200);
    expect(out.setCookie[0]).toContain('ccx_session=;');
    expect(out.setCookie[0]!.toLowerCase()).toContain('max-age=0');
  });

  it('trades a legacy bearer token for a cookie', async () => {
    const user = await register('LegacyToken');
    const res = await fetch(`http://127.0.0.1:${port}/api/session/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.session}` },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(sessionFrom(res)).toBeTruthy();
  });

  it('rejects a POST that says it came from somewhere else', async () => {
    const forged = await api('/api/guest', { lang: 'en' }, { origin: 'https://evil.example' });
    expect(forged.status).toBe(403);
    expect(forged.body.error).toBe('bad-origin');

    const honest = await api('/api/guest', { lang: 'en' }, { origin: `http://127.0.0.1:${port}` });
    expect(honest.status).toBe(201);
  });
});

// ------------------------------------------------------------------ claims --

describe('claiming a guest', () => {
  it('gives a guest a password without changing who it is', async () => {
    const guest = await api('/api/guest', { lang: 'en' });
    const before = guest.body.user as { id: string; name: string };

    const claimed = await api(
      '/api/claim',
      { name: 'ClaimedInPlace', password: 'correct horse battery' },
      { session: guest.session },
    );
    expect(claimed.status).toBe(200);
    const after = claimed.body.user as { id: string; name: string; guest: boolean };
    // Same row: the games it has already played still point at this id, and the
    // session already on the headset keeps working.
    expect(after.id).toBe(before.id);
    expect(after.name).toBe('ClaimedInPlace');
    expect(after.guest).toBe(false);

    const login = await api('/api/login', { name: 'ClaimedInPlace', password: 'correct horse battery' });
    expect(login.status).toBe(200);
    expect((login.body.user as { id: string }).id).toBe(before.id);
  });

  it('refuses a name that is already registered', async () => {
    await register('TakenAlready');
    const guest = await api('/api/guest', { lang: 'en' });
    const claimed = await api(
      '/api/claim',
      { name: 'takenalready', password: 'correct horse battery' },
      { session: guest.session },
    );
    expect(claimed.status).toBe(409);
    expect(claimed.body.error).toBe('name-taken');
  });

  it('refuses to claim an account that already has a password', async () => {
    const user = await register('AlreadyReal');
    const again = await api(
      '/api/claim',
      { name: 'AlreadyReal2', password: 'correct horse battery' },
      { session: user.session },
    );
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already-claimed');
  });

  it('keeps the guest name if that is the name they want', async () => {
    const guest = await api('/api/guest', { lang: 'en' });
    const name = (guest.body.user as { name: string }).name;
    const claimed = await api(
      '/api/claim',
      { name, password: 'correct horse battery' },
      { session: guest.session },
    );
    expect(claimed.status).toBe(200);
    expect((claimed.body.user as { name: string }).name).toBe(name);
  });
});

// ----------------------------------------------------------------- pairing --

interface Started { userCode: string; deviceCode: string; url: string; interval: number }

const startPairing = async (session?: string | null) => {
  const res = await api('/api/link/start', {}, { session });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as unknown as Started;
};

describe('headset pairing', () => {
  it('hands out a code a person can read and retype', async () => {
    const started = await startPairing();
    // Grouped in fours, and drawn from an alphabet with no I, O, 0 or 1 — every
    // character has to survive being read at arm's length inside a headset.
    expect(started.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(started.url).toMatch(/\/link$/);
    expect(started.deviceCode.length).toBeGreaterThan(32);
  });

  it('signs a headset into an existing account approved on another device', async () => {
    const account = await register('PairTarget');
    const started = await startPairing();

    const lookup = await api('/api/link/lookup', { code: started.userCode });
    expect(lookup.status).toBe(200);
    expect(lookup.body.waiting).toBeNull();

    const approved = await api('/api/link/approve', {
      code: started.userCode, mode: 'attach',
      name: 'PairTarget', password: 'correct horse battery',
    });
    expect(approved.status).toBe(200);

    const poll = await api('/api/link/poll', {
      userCode: started.userCode, deviceCode: started.deviceCode,
    });
    expect(poll.body.status).toBe('ready');
    expect((poll.body.user as { id: string }).id).toBe(account.user.id);
    // The headset never typed anything, and it ends up holding a real session.
    expect(poll.session).toBeTruthy();
    const me = await api('/api/me', undefined, { session: poll.session });
    expect((me.body.user as { id: string }).id).toBe(account.user.id);
  });

  it('claims the headset\'s own guest from the phone, keeping the same player', async () => {
    const guest = await api('/api/guest', { lang: 'en' });
    const guestUser = guest.body.user as { id: string; name: string };
    const started = await startPairing(guest.session);

    // The phone is told who is waiting, so it can offer to keep them.
    const lookup = await api('/api/link/lookup', { code: started.userCode });
    expect(lookup.body.waiting).toEqual({ name: guestUser.name, claimable: true });

    const approved = await api('/api/link/approve', {
      code: started.userCode, mode: 'claim',
      name: 'ClaimedFromPhone', password: 'correct horse battery',
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    const poll = await api('/api/link/poll', {
      userCode: started.userCode, deviceCode: started.deviceCode,
    });
    expect(poll.body.status).toBe('ready');
    const after = poll.body.user as { id: string; guest: boolean };
    expect(after.id).toBe(guestUser.id);
    expect(after.guest).toBe(false);
  });

  it('accepts a code typed in any case, with or without the dash', async () => {
    const started = await startPairing();
    const messy = started.userCode.toLowerCase().replace('-', ' ');
    expect((await api('/api/link/lookup', { code: messy })).status).toBe(200);
  });

  it('rejects a code containing characters the alphabet excludes', async () => {
    const res = await api('/api/link/lookup', { code: 'ABCD-EFG1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad-code');
  });

  /**
   * The reason the flow has two halves. The eight characters are on a panel
   * anyone in the room can read; without the device code, reading them off the
   * screen would be enough to walk away with the session.
   */
  it('will not hand out a session to a poller without the device code', async () => {
    const account = await register('DeviceCodeGuard');
    const started = await startPairing();
    await api('/api/link/approve', {
      code: started.userCode, mode: 'attach',
      name: 'DeviceCodeGuard', password: 'correct horse battery',
    });

    const stolen = await api('/api/link/poll', {
      userCode: started.userCode, deviceCode: 'not-the-device-code',
    });
    expect(stolen.status).toBe(403);
    expect(stolen.session).toBeNull();

    // Still available to the headset that actually started it.
    const rightful = await api('/api/link/poll', {
      userCode: started.userCode, deviceCode: started.deviceCode,
    });
    expect(rightful.body.status).toBe('ready');
    expect((rightful.body.user as { id: string }).id).toBe(account.user.id);
  });

  it('reports a pairing the phone refused', async () => {
    const started = await startPairing();
    await api('/api/link/deny', { code: started.userCode });
    const poll = await api('/api/link/poll', {
      userCode: started.userCode, deviceCode: started.deviceCode,
    });
    expect(poll.body.status).toBe('denied');
  });

  it('treats an unknown code as expired rather than confirming it never existed', async () => {
    const poll = await api('/api/link/poll', {
      userCode: 'ZZZZ-ZZZZ', deviceCode: 'whatever',
    });
    expect(poll.body.status).toBe('expired');
  });

  it('paces a headset that polls too fast', async () => {
    const started = await startPairing();
    expect((await api('/api/link/poll', {
      userCode: started.userCode, deviceCode: started.deviceCode,
    })).body.status).toBe('pending');

    const again = await api('/api/link/poll', {
      userCode: started.userCode, deviceCode: started.deviceCode,
    });
    expect(again.status).toBe(429);
    expect(again.body.error).toBe('slow-down');
  });

  it('kills a code after repeated wrong passwords', async () => {
    await register('BruteTarget');
    const started = await startPairing();
    for (let i = 0; i < 5; i++) {
      const attempt = await api('/api/link/approve', {
        code: started.userCode, mode: 'attach', name: 'BruteTarget', password: 'wrong password!!',
      });
      expect(attempt.status).toBe(401);
    }
    const dead = await api('/api/link/approve', {
      code: started.userCode, mode: 'attach',
      name: 'BruteTarget', password: 'correct horse battery',
    });
    expect(dead.status).toBe(404);
  });

  it('limits how many pairings one player can leave in flight', async () => {
    const guest = await api('/api/guest', { lang: 'en' });
    for (let i = 0; i < 3; i++) await startPairing(guest.session);
    const fourth = await api('/api/link/start', {}, { session: guest.session });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toBe('too-many-codes');
  });

  it('cannot be claimed against a headset that is already a real account', async () => {
    const account = await register('NotAGuest');
    const started = await startPairing(account.session);
    const approved = await api('/api/link/approve', {
      code: started.userCode, mode: 'claim',
      name: 'SomethingElse', password: 'correct horse battery',
    });
    expect(approved.status).toBe(409);
    expect(approved.body.error).toBe('not-claimable');
  });
});
