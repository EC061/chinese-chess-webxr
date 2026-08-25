/**
 * JSON API: sessions, accounts, headset pairing, profile, ladder, health.
 *
 * Two things shape this file, and both come from the headset rather than the
 * browser. First, the session lives in an HttpOnly cookie: a Quest is signed in
 * for months, so the credential on the device is long-lived and script on the
 * page must not be able to read it. Second, nothing here requires typing in
 * VR — a player arrives as a named guest without being asked anything, and
 * turns that into a real account from their phone.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  NAME_PATTERN, PASSWORD_MAX, PASSWORD_MIN, SESSION_COOKIE, clearedSessionCookie,
  deviceCodeMatches, formatUserCode, hashDeviceCode, hashPassword, issueToken, newDeviceCode,
  newGuestName, newUserCode, normaliseUserCode, parseCookies, serializeSessionCookie,
  tokenTtlMs, verifyPassword, verifyToken, type TokenPayload,
} from './auth.js';
import type { Config, Logger } from './config.js';
import type { Store, UserRow } from './db.js';
import { isProvisional, LEVELS_INFO } from './info.js';
import { expectedOrigin, originAllowed } from './origin.js';

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

const setCookie = (res: ServerResponse, value: string): void => {
  const existing = res.getHeader('Set-Cookie');
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('Set-Cookie', [...list, value]);
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

/**
 * Endpoints a wrong guess gets you something on. Deliberately not the whole
 * POST surface: a headset waiting to be paired polls every couple of seconds,
 * which would exhaust a per-minute budget meant for password attempts. Polling
 * is paced by its own guard instead.
 */
const THROTTLED = new Set([
  '/api/register', '/api/login', '/api/guest', '/api/claim',
  '/api/link/start', '/api/link/lookup', '/api/link/approve', '/api/link/deny',
]);

/**
 * A session is refreshed rather than re-created on every visit, but writing a
 * cookie on literally every authenticated request is noise. A day's grace keeps
 * the sliding window moving without re-stamping during a single sitting.
 */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** How long the maximum pairing code lives, in seconds, for the client's timer. */
const secondsUntil = (at: number): number => Math.max(0, Math.round((at - Date.now()) / 1000));

export const createApi = (deps: ApiDeps) => {
  const { store, config, log } = deps;
  const authThrottle = new Throttle(config.authRateLimit, config.authRateWindowMs);
  /** Last poll per pairing code, so a client cannot spin on /api/link/poll. */
  const lastPoll = new Map<string, number>();
  setInterval(() => {
    authThrottle.sweep();
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [code, at] of lastPoll) if (at < cutoff) lastPoll.delete(code);
  }, 60_000).unref();

  /** True when this key has waited its interval; records the attempt if so. */
  const pace = (key: string): boolean => {
    const previous = lastPoll.get(key);
    if (previous !== undefined && Date.now() - previous < config.linkPollIntervalMs * 0.8) return false;
    lastPoll.set(key, Date.now());
    return true;
  };

  /**
   * Put a session on the device. `persist` is the player's answer to "stay
   * signed in on this headset": true gives a dated cookie the browser keeps
   * across restarts, false gives a session cookie that dies with the browser —
   * which is what you want on a headset somebody else in the house also wears.
   */
  const issueSession = (res: ServerResponse, user: UserRow, persist: boolean): void => {
    const now = Date.now();
    const ttl = tokenTtlMs(persist, config.sessionPersistDays);
    const token = issueToken(config.sessionSecret, {
      sub: user.id,
      guest: user.guest === 1,
      persist,
      iat: now,
      exp: now + ttl,
    });
    setCookie(res, serializeSessionCookie(token, {
      maxAgeSeconds: persist ? Math.floor(ttl / 1000) : null,
      secure: config.secureCookies,
    }));
  };

  const endSession = (res: ServerResponse): void => {
    setCookie(res, clearedSessionCookie(config.secureCookies));
  };

  /**
   * The cookie is the browser path; the bearer header stays for clients that can
   * set headers on a socket handshake and therefore never needed a cookie.
   */
  const session = (req: IncomingMessage): { user: UserRow; payload: TokenPayload } | null => {
    const header = req.headers.authorization;
    const fromCookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const token = fromCookie ?? (header?.startsWith('Bearer ') ? header.slice(7) : null);
    if (!token) return null;
    const payload = verifyToken(config.sessionSecret, token);
    if (!payload) return null;
    const user = store.userById(payload.sub);
    return user ? { user, payload } : null;
  };

  /** Re-stamp a persistent cookie so its expiry slides forward from today. */
  const refreshIfStale = (res: ServerResponse, found: { user: UserRow; payload: TokenPayload }): void => {
    if (!found.payload.persist) return;
    if (Date.now() - found.payload.iat < REFRESH_AFTER_MS) return;
    issueSession(res, found.user, true);
  };

  const persistFrom = (body: Record<string, unknown>): boolean => body.persist !== false;

  const langFrom = (body: Record<string, unknown>): 'zh' | 'en' => (body.lang === 'en' ? 'en' : 'zh');

  /** A free name built from `base`, or null if the space is somehow exhausted. */
  const availableName = (base: string, lang: 'zh' | 'en'): string | null => {
    if (NAME_PATTERN.test(base) && !store.userByName(base)) return base;
    for (let i = 0; i < 24; i++) {
      const candidate = newGuestName(lang);
      if (!store.userByName(candidate)) return candidate;
    }
    return null;
  };

  const sessionBody = (user: UserRow, persist: boolean) => ({
    user: publicUser(user),
    session: { persist, guest: user.guest === 1 },
  });

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
        linkPollIntervalMs: config.linkPollIntervalMs,
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
      const found = session(req);
      if (!found) { json(res, 401, { error: 'unauthorized' }); return true; }
      const { user, payload } = found;
      store.touchUser(user.id);
      // Every visit slides the cookie's expiry forward. This is the whole
      // mechanism keeping a headset signed in indefinitely: the browser caps a
      // cookie at 400 days from when it was set, so the only way to stay signed
      // in past that is to keep setting it.
      refreshIfStale(res, found);
      json(res, 200, {
        ...sessionBody(user, payload.persist),
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
    if (!originAllowed(req, config)) { json(res, 403, { error: 'bad-origin' }); return true; }
    if (THROTTLED.has(path) && !authThrottle.check(ip)) {
      json(res, 429, { error: 'rate-limited' });
      return true;
    }

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
      const persist = persistFrom(body);
      const user = store.createUser(name, await hashPassword(password), false);
      log.info(`registered ${user.name}`);
      issueSession(res, user, persist);
      json(res, 201, sessionBody(user, persist));
      return true;
    }

    if (path === '/api/login') {
      const user = store.userByName(name);
      // Same response either way, so the endpoint does not confirm which names exist.
      if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
        json(res, 401, { error: 'bad-credentials', message: 'Wrong name or password.' });
        return true;
      }
      const persist = persistFrom(body);
      store.touchUser(user.id);
      issueSession(res, user, persist);
      json(res, 200, sessionBody(user, persist));
      return true;
    }

    /**
     * A playable identity with nothing asked of the player. The client calls
     * this on first load, so the first thing a headset shows is a board rather
     * than a name field — and because the row is a real user, the rating it
     * earns is kept when the player later claims it.
     */
    if (path === '/api/guest') {
      if (!config.allowGuests) { json(res, 403, { error: 'guests-disabled' }); return true; }
      const lang = langFrom(body);
      const chosen = availableName(name || newGuestName(lang), lang);
      if (!chosen) { json(res, 503, { error: 'name-exhausted' }); return true; }
      const persist = persistFrom(body);
      const user = store.createUser(chosen, null, true);
      issueSession(res, user, persist);
      json(res, 201, sessionBody(user, persist));
      return true;
    }

    /**
     * Upgrade the *current* guest session to a real account. Same row, same id,
     * same rating — the difference between this and registering is a fortnight
     * of ladder history.
     */
    if (path === '/api/claim') {
      const found = session(req);
      if (!found) { json(res, 401, { error: 'unauthorized' }); return true; }
      if (found.user.guest !== 1) { json(res, 409, { error: 'already-claimed' }); return true; }
      const outcome = await claim(found.user, name, password);
      if ('error' in outcome) { json(res, outcome.status, outcome); return true; }
      issueSession(res, outcome.user, found.payload.persist);
      log.info(`guest claimed as ${outcome.user.name}`);
      json(res, 200, sessionBody(outcome.user, found.payload.persist));
      return true;
    }

    /** The "stay signed in on this headset" switch, after the fact. */
    if (path === '/api/session/persist') {
      const found = session(req);
      if (!found) { json(res, 401, { error: 'unauthorized' }); return true; }
      const persist = persistFrom(body);
      issueSession(res, found.user, persist);
      json(res, 200, sessionBody(found.user, persist));
      return true;
    }

    /**
     * Trade a token the page is holding for a cookie. Only reachable with a
     * valid session already, so it grants nothing new — it exists so devices
     * signed in before the session moved into a cookie do not get logged out,
     * and so the page can drop its copy of the token afterwards.
     */
    if (path === '/api/session/adopt') {
      const found = session(req);
      if (!found) { json(res, 401, { error: 'unauthorized' }); return true; }
      const persist = persistFrom(body);
      issueSession(res, found.user, persist);
      json(res, 200, sessionBody(found.user, persist));
      return true;
    }

    if (path === '/api/logout') {
      endSession(res);
      json(res, 200, { ok: true });
      return true;
    }

    // ------------------------------------------------------------ pairing ---

    /**
     * Start a pairing. The headset shows the user code and holds the device
     * code; approval happens on a phone, where there is a keyboard. This is the
     * device authorization grant (RFC 8628) in the shape it takes for a browser:
     * no client registration, and the reward is a cookie rather than a token.
     */
    if (path === '/api/link/start') {
      const found = session(req);
      // A guest starting a pairing is the common case, and it is what lets the
      // phone offer "keep this player's rating" instead of only "sign in".
      const origin = found?.user.guest === 1 ? found.user.id : null;
      if (origin && store.countPendingLinkCodes(origin) >= 3) {
        json(res, 429, { error: 'too-many-codes' });
        return true;
      }
      let code = newUserCode();
      for (let i = 0; store.linkCode(code) && i < 8; i++) code = newUserCode();
      if (store.linkCode(code)) { json(res, 503, { error: 'code-exhausted' }); return true; }
      const deviceCode = newDeviceCode();
      const row = store.createLinkCode(
        code, hashDeviceCode(config.sessionSecret, deviceCode), origin, config.linkTtlMs,
      );
      json(res, 201, {
        userCode: formatUserCode(code),
        deviceCode,
        expiresIn: secondsUntil(row.expires_at),
        interval: Math.round(config.linkPollIntervalMs / 1000),
        // Shown next to the code, so the player knows where to go on the phone.
        url: `${expectedOrigin(req, config) ?? ''}/link`,
      });
      return true;
    }

    /**
     * The headset asking whether the phone is done. Answering with the session
     * requires the device code, so knowing the eight characters on the panel is
     * not enough to walk off with the account.
     */
    if (path === '/api/link/poll') {
      const deviceCode = typeof body.deviceCode === 'string' ? body.deviceCode : '';
      const code = normaliseUserCode(typeof body.userCode === 'string' ? body.userCode : '');
      if (!deviceCode || !code) { json(res, 400, { error: 'bad-request' }); return true; }

      const row = store.linkCode(code);
      // An unknown code and an expired one are the same answer on purpose.
      if (!row || row.expires_at < Date.now()) {
        // Pace by address here rather than by code: this is the path someone
        // guessing codes lands on, and there is no legitimate client to slow.
        if (!pace(`ip:${ip}`)) { json(res, 429, { error: 'slow-down' }); return true; }
        json(res, 200, { status: 'expired' });
        return true;
      }
      if (!deviceCodeMatches(config.sessionSecret, deviceCode, row.device_hash)) {
        json(res, 403, { error: 'bad-device-code' });
        return true;
      }
      // Paced only once the caller has proved it is the headset that started
      // this pairing — otherwise anyone who can read the code off the panel
      // could keep the real headset's polls bouncing off the rate limit.
      if (!pace(code)) {
        json(res, 429, { error: 'slow-down', interval: Math.round(config.linkPollIntervalMs / 1000) });
        return true;
      }
      if (row.status === 'denied') {
        store.deleteLinkCode(code);
        json(res, 200, { status: 'denied' });
        return true;
      }
      if (row.status !== 'approved' || !row.user_id) {
        json(res, 200, { status: 'pending', expiresIn: secondsUntil(row.expires_at) });
        return true;
      }
      const user = store.userById(row.user_id);
      store.deleteLinkCode(code);
      if (!user) { json(res, 200, { status: 'expired' }); return true; }
      const persist = persistFrom(body);
      store.touchUser(user.id);
      issueSession(res, user, persist);
      json(res, 200, { status: 'ready', ...sessionBody(user, persist) });
      return true;
    }

    /** The phone, checking a typed code before asking for a password. */
    if (path === '/api/link/lookup') {
      const code = normaliseUserCode(typeof body.code === 'string' ? body.code : '');
      if (!code) { json(res, 400, { error: 'bad-code' }); return true; }
      const row = store.linkCode(code);
      if (!row || row.expires_at < Date.now() || row.status !== 'pending') {
        json(res, 404, { error: 'no-such-code' });
        return true;
      }
      const origin = row.origin_user_id ? store.userById(row.origin_user_id) : null;
      const claimable = origin?.guest === 1;
      json(res, 200, {
        expiresIn: secondsUntil(row.expires_at),
        // What the headset is currently signed in as, so the phone can offer to
        // keep it rather than silently replacing it.
        // No rating here on purpose: a guest has not played a rated game, so its
        // 1500 would be a number that means nothing.
        waiting: claimable && origin ? { name: origin.name, claimable: true } : null,
      });
      return true;
    }

    /** The phone, approving. `attach` signs the headset into an existing
     *  account; `claim` turns the guest the headset is already using into one. */
    if (path === '/api/link/approve') {
      const code = normaliseUserCode(typeof body.code === 'string' ? body.code : '');
      if (!code) { json(res, 400, { error: 'bad-code' }); return true; }
      const row = store.linkCode(code);
      if (!row || row.expires_at < Date.now() || row.status !== 'pending') {
        json(res, 404, { error: 'no-such-code' });
        return true;
      }
      if (row.attempts >= 5) {
        store.deleteLinkCode(code);
        json(res, 429, { error: 'too-many-attempts' });
        return true;
      }

      if (body.mode === 'claim') {
        const origin = row.origin_user_id ? store.userById(row.origin_user_id) : null;
        if (!origin || origin.guest !== 1) { json(res, 409, { error: 'not-claimable' }); return true; }
        const outcome = await claim(origin, name, password);
        if ('error' in outcome) {
          store.noteLinkAttempt(code);
          json(res, outcome.status, outcome);
          return true;
        }
        store.setLinkStatus(code, 'approved', outcome.user.id);
        log.info(`guest claimed as ${outcome.user.name} from a paired phone`);
        json(res, 200, { ok: true, mode: 'claim', user: publicUser(outcome.user) });
        return true;
      }

      const user = store.userByName(name);
      if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) {
        const attempts = store.noteLinkAttempt(code);
        if (attempts >= 5) store.deleteLinkCode(code);
        json(res, 401, { error: 'bad-credentials', message: 'Wrong name or password.' });
        return true;
      }
      store.setLinkStatus(code, 'approved', user.id);
      json(res, 200, { ok: true, mode: 'attach', user: publicUser(user) });
      return true;
    }

    /** "That wasn't me" — stops the headset waiting on a code it can see. */
    if (path === '/api/link/deny') {
      const code = normaliseUserCode(typeof body.code === 'string' ? body.code : '');
      if (!code) { json(res, 400, { error: 'bad-code' }); return true; }
      const row = store.linkCode(code);
      if (row && row.status === 'pending') store.setLinkStatus(code, 'denied', null);
      json(res, 200, { ok: true });
      return true;
    }

    json(res, 404, { error: 'not-found' });
    return true;
  };

  /** Shared by the in-app claim and the paired-phone claim. */
  async function claim(
    guest: UserRow, name: string, password: string,
  ): Promise<{ user: UserRow } | { error: string; message?: string; status: number }> {
    if (!NAME_PATTERN.test(name)) {
      return { error: 'bad-name', message: 'Use 2–20 letters, digits, spaces, - _ or .', status: 400 };
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return { error: 'bad-password', message: `Password must be at least ${PASSWORD_MIN} characters.`, status: 400 };
    }
    const existing = store.userByName(name);
    if (existing && existing.id !== guest.id) {
      return { error: 'name-taken', message: 'That name is already registered.', status: 409 };
    }
    if (!store.claimGuest(guest.id, name, await hashPassword(password))) {
      return { error: 'already-claimed', status: 409 };
    }
    return { user: store.userById(guest.id)! };
  }
};
