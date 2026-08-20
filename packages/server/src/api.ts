/** JSON API: accounts, profile, ladder, health. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GUEST_TTL_MS, NAME_PATTERN, PASSWORD_MAX, PASSWORD_MIN, SESSION_TTL_MS, hashPassword,
  issueToken, verifyPassword, verifyToken,
} from './auth.js';
import type { Config, Logger } from './config.js';
import type { Store, UserRow } from './db.js';
import { isProvisional, LEVELS_INFO } from './info.js';

const readBody = async (req: IncomingMessage, limit = 8 * 1024): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
};

const publicUser = (user: UserRow) => ({
  id: user.id,
  name: user.name,
  rating: Math.round(user.rating),
  rd: Math.round(user.rd),
  provisional: isProvisional(user),
  guest: user.guest === 1,
  wins: user.wins,
  losses: user.losses,
  draws: user.draws,
  aiWins: user.ai_wins,
  aiLosses: user.ai_losses,
  aiDraws: user.ai_draws,
});

export interface ApiDeps {
  store: Store;
  config: Config;
  log: Logger;
  stats: () => { rooms: number; clients: number; playing: number };
}

/** Simple per-IP throttle for the auth endpoints, which are the guessable ones. */
class Throttle {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.hits) if (entry.resetAt < now) this.hits.delete(key);
  }
}

export const createApi = (deps: ApiDeps) => {
  const { store, config, log } = deps;
  const authThrottle = new Throttle(config.authRateLimit, config.authRateWindowMs);
  setInterval(() => authThrottle.sweep(), 60_000).unref();

  const tokenFor = (user: UserRow): string => issueToken(config.sessionSecret, {
    sub: user.id,
    guest: user.guest === 1,
    exp: Date.now() + (user.guest === 1 ? GUEST_TTL_MS : SESSION_TTL_MS),
  });

  const currentUser = (req: IncomingMessage): UserRow | null => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return null;
    const payload = verifyToken(config.sessionSecret, token);
    return payload ? store.userById(payload.sub) : null;
  };

  /** Returns true when the request was handled. */
  return async (req: IncomingMessage, res: ServerResponse, ip: string): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/') && path !== '/healthz') return false;

    if (path === '/healthz') {
      json(res, 200, { ok: true, ...deps.stats(), users: store.countUsers(), games: store.countGames() });
      return true;
    }

    if (path === '/api/config' && req.method === 'GET') {
      json(res, 200, {
        allowGuests: config.allowGuests,
        rateAiGames: config.rateAiGames,
        undoMakesUnrated: config.undoMakesUnrated,
        crossOriginIsolation: config.crossOriginIsolation,
        aiLevels: LEVELS_INFO,
      });
      return true;
    }

    if (path === '/api/leaderboard' && req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25));
      json(res, 200, {
        entries: store.leaderboard(limit, config.leaderboardMinGames).map(publicUser),
      });
      return true;
    }

    if (path === '/api/me' && req.method === 'GET') {
      const user = currentUser(req);
      if (!user) { json(res, 401, { error: 'unauthorized' }); return true; }
      store.touchUser(user.id);
      json(res, 200, {
        user: publicUser(user),
        recent: store.recentGames(user.id, 20).map((g) => ({
          id: g.id,
          mode: g.mode,
          aiLevel: g.ai_level,
          result: g.result,
          reason: g.reason,
          rated: g.rated === 1,
          youWere: g.red_id === user.id ? 'red' : 'black',
          at: g.created_at,
        })),
      });
      return true;
    }

    if (req.method !== 'POST') { json(res, 405, { error: 'method-not-allowed' }); return true; }
    if (!authThrottle.check(ip)) { json(res, 429, { error: 'rate-limited' }); return true; }

    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch {
      json(res, 400, { error: 'bad-json' });
      return true;
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (path === '/api/register') {
      if (!NAME_PATTERN.test(name)) {
        json(res, 400, { error: 'bad-name', message: 'Use 2–20 letters, digits, spaces, - _ or .' });
        return true;
      }
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        json(res, 400, { error: 'bad-password', message: `Password must be at least ${PASSWORD_MIN} characters.` });
        return true;
      }
      if (store.userByName(name)) {
        json(res, 409, { error: 'name-taken', message: 'That name is already registered.' });
        return true;
      }
      const user = store.createUser(name, await hashPassword(password), false);
      log.info(`registered ${user.name}`);
      json(res, 201, { token: tokenFor(user), user: publicUser(user) });
      return true;
    }

    if (path === '/api/login') {
      const user = store.userByName(name);
      // Same response either way, so the endpoint does not confirm which names exist.
      if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
        json(res, 401, { error: 'bad-credentials', message: 'Wrong name or password.' });
        return true;
      }
      store.touchUser(user.id);
      json(res, 200, { token: tokenFor(user), user: publicUser(user) });
      return true;
    }

    if (path === '/api/guest') {
      if (!config.allowGuests) { json(res, 403, { error: 'guests-disabled' }); return true; }
      const base = NAME_PATTERN.test(name) ? name : 'Guest';
      // Guests get a numeric suffix so two "Guest" players are distinguishable.
      let candidate = base;
      for (let i = 0; store.userByName(candidate); i++) {
        candidate = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
        if (i > 20) { json(res, 503, { error: 'name-exhausted' }); return true; }
      }
      const user = store.createUser(candidate, null, true);
      json(res, 201, { token: tokenFor(user), user: publicUser(user) });
      return true;
    }

    json(res, 404, { error: 'not-found' });
    return true;
  };
};
