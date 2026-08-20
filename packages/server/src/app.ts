/**
 * The application, assembled from a Config. Kept as a factory rather than
 * module-level side effects so tests can bring up a real server on an ephemeral
 * port, drive it over real WebSockets, and tear it down again.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClientMessage, ERROR_CODES, type ServerMessage } from '@ccx/shared';
import { createApi } from './api.js';
import { verifyToken } from './auth.js';
import { createLogger, type Config } from './config.js';
import { Store } from './db.js';
import { Hub, type Client } from './rooms.js';
import { applySecurityHeaders, createStaticHandler } from './static.js';

/** Ordinary messages per second, and a looser allowance for pose streaming. */
const MESSAGE_RATE = 40;
const POSE_RATE = 60;

export interface App {
  listen(): Promise<number>;
  close(): Promise<void>;
  readonly store: Store;
  readonly hub: Hub;
}

export const createApp = (config: Config): App => {
const log = createLogger(config.logLevel);
const store = new Store(config.databasePath);
const hub = new Hub(store, config, log);
const serveStatic = createStaticHandler(config);
const api = createApi({ store, config, log, stats: () => hub.stats() });

const clientIp = (req: IncomingMessage): string => {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first) return first.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
};

const server = createServer((req, res) => {
  applySecurityHeaders(res, config);
  const ip = clientIp(req);

  void (async () => {
    try {
      if (await api(req, res, ip)) return;
      if (serveStatic(req, res)) return;
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Not found');
    } catch (error) {
      log.error('request failed', error instanceof Error ? error.message : String(error));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal error');
      }
    }
  })();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const connectionsPerIp = new Map<string, number>();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const ip = clientIp(req);
  const current = connectionsPerIp.get(ip) ?? 0;
  if (current >= config.maxConnectionsPerIp) {
    log.warn(`connection limit hit for ${ip}`);
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  // Browsers cannot set headers on a WebSocket handshake, so the session token
  // travels in the query string. It is only ever sent over TLS in production.
  const token = url.searchParams.get('token');
  const payload = token ? verifyToken(config.sessionSecret, token) : null;
  if (!payload) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const user = store.userById(payload.sub);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    connectionsPerIp.set(ip, current + 1);
    ws.once('close', () => {
      const n = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, n);
    });
    attach(ws, user.id, user.name, ip);
  });
});

const attach = (ws: WebSocket, userId: string, name: string, ip: string): void => {
  const client: Client = {
    id: randomUUID(),
    userId,
    name,
    ip,
    roomId: null,
    lobby: false,
    budget: MESSAGE_RATE,
    budgetAt: Date.now(),
    poseBudget: POSE_RATE,
    poseBudgetAt: Date.now(),
    lastAiReportAt: 0,
    send(message: ServerMessage) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    },
    close(code = 1000, reason = '') {
      ws.close(code, reason);
    },
  };

  hub.addClient(client);
  const user = store.userById(userId)!;
  client.send({
    t: 'hello',
    version: 1,
    user: {
      id: user.id,
      name: user.name,
      rating: Math.round(user.rating),
      rd: Math.round(user.rd),
      provisional: user.rd > 110,
      guest: user.guest === 1,
    },
  });

  let alive = true;
  ws.on('pong', () => { alive = true; });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 30_000);

  ws.on('message', (raw) => {
    if (!spend(client, raw)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      client.send({ t: 'error', code: ERROR_CODES.BAD_MESSAGE, message: 'Malformed JSON.' });
      return;
    }
    const result = ClientMessage.safeParse(parsed);
    if (!result.success) {
      client.send({
        t: 'error',
        code: ERROR_CODES.BAD_MESSAGE,
        message: result.error.issues[0]?.message ?? 'Unrecognised message.',
      });
      return;
    }
    try {
      dispatch(client, result.data);
    } catch (error) {
      log.error('dispatch failed', error instanceof Error ? error.stack ?? error.message : String(error));
      client.send({ t: 'error', code: 'INTERNAL', message: 'Something went wrong.' });
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    hub.removeClient(client);
    hub.flushLobby();
  });

  ws.on('error', (error) => {
    log.debug(`socket error for ${client.name}`, error.message);
  });
};

/** Token-bucket rate limiting, with a separate allowance for pose streaming. */
const spend = (client: Client, raw: unknown): boolean => {
  const now = Date.now();
  const text = String(raw);
  const isStream = text.includes('"room:pose"') || text.includes('"game:grab"');

  if (isStream) {
    if (now - client.poseBudgetAt >= 1000) {
      client.poseBudget = POSE_RATE;
      client.poseBudgetAt = now;
    }
    if (client.poseBudget-- <= 0) return false; // silently dropped: it is only presence
    return true;
  }

  if (now - client.budgetAt >= 1000) {
    client.budget = MESSAGE_RATE;
    client.budgetAt = now;
  }
  if (client.budget-- <= 0) {
    client.send({ t: 'error', code: ERROR_CODES.RATE_LIMITED, message: 'Slow down.' });
    return false;
  }
  return true;
};

const dispatch = (client: Client, message: ClientMessage): void => {
  switch (message.t) {
    case 'ping':
      client.send({ t: 'pong', at: message.at });
      break;
    case 'lobby:subscribe':
      hub.subscribeLobby(client);
      break;
    case 'lobby:unsubscribe':
      hub.unsubscribeLobby(client);
      break;
    case 'leaderboard:get':
      hub.sendLeaderboard(client, message.limit ?? 25);
      break;
    case 'room:create':
      hub.createRoom(client, {
        name: message.name,
        passcode: message.passcode,
        side: message.side,
        rated: message.rated,
        timeControl: message.timeControl,
        open: message.open,
      });
      break;
    case 'room:join':
      hub.joinRoom(client, message.roomId, message.passcode, false);
      break;
    case 'room:spectate':
      hub.joinRoom(client, message.roomId, message.passcode, true);
      break;
    case 'room:leave':
      hub.leaveRoom(client);
      break;
    case 'room:emote':
      hub.emote(client, message.emote);
      break;
    case 'room:pose':
      hub.pose(client, message.head, message.hands);
      break;
    case 'game:move':
      hub.move(client, message.iccs);
      break;
    case 'game:grab':
      hub.grab(client, message.square);
      break;
    case 'game:resign':
      hub.resign(client);
      break;
    case 'game:undo-request':
      hub.requestUndo(client);
      break;
    case 'game:undo-response':
      hub.respondUndo(client, message.accept);
      break;
    case 'game:draw-offer':
      hub.offerDraw(client);
      break;
    case 'game:draw-response':
      hub.respondDraw(client, message.accept);
      break;
    case 'game:rematch':
      hub.rematch(client);
      break;
    case 'ai:report':
      hub.reportAiGame(client, message);
      break;
  }
  hub.flushLobby();
};

const sweeper = setInterval(() => {
  hub.sweep();
  // Guests that never played and have not been seen for a week are noise.
  const pruned = store.pruneGuests(7 * 24 * 60 * 60 * 1000);
  if (pruned) log.info(`pruned ${pruned} stale guest accounts`);
}, 60_000);

return {
  store,
  hub,
  listen(): Promise<number> {
    return new Promise((resolve) => {
      server.listen(config.port, config.host, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : config.port;
        log.info(`中国象棋 WebXR server listening on http://${config.host}:${port}`);
        log.info(`database: ${config.databasePath}  static: ${config.staticDir}`);
        log.info(
          `cross-origin isolation ${config.crossOriginIsolation ? 'on' : 'off'} `
          + `(multi-threaded AI ${config.crossOriginIsolation ? 'available' : 'disabled'})`,
        );
        resolve(port);
      });
    });
  },
  async close(): Promise<void> {
    clearInterval(sweeper);
    // Wait for every socket's close handler to finish before the database goes
    // away — those handlers still read from it to update room state.
    await Promise.all([...wss.clients].map((ws) => new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close(1001, 'server shutting down');
      setTimeout(() => { ws.terminate(); resolve(); }, 1000).unref();
    })));
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  },
};
};
