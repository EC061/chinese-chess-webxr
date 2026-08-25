/**
 * Configuration, entirely from the environment. Every variable is documented in
 * `.env.example` and surfaced in `docker-compose.yml`; anything without a safe
 * default refuses to start in production rather than silently degrading.
 */
import { randomBytes } from 'node:crypto';
import { MAX_COOKIE_DAYS } from './auth.js';

const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const int = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

export interface Config {
  env: 'production' | 'development';
  host: string;
  port: number;
  publicOrigin: string | null;
  sessionSecret: string;
  databasePath: string;
  staticDir: string;
  allowGuests: boolean;
  rateAiGames: boolean;
  undoMakesUnrated: boolean;
  maxRooms: number;
  maxRoomsPerUser: number;
  roomIdleMs: number;
  crossOriginIsolation: boolean;
  trustProxy: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  maxConnectionsPerIp: number;
  leaderboardMinGames: number;
  undoResponseTimeoutMs: number;
  aiReportCooldownMs: number;
  authRateLimit: number;
  authRateWindowMs: number;
  secureCookies: boolean;
  sessionPersistDays: number;
  linkTtlMs: number;
  linkPollIntervalMs: number;
}

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const mode = env.NODE_ENV === 'production' ? 'production' : 'development';

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (!sessionSecret) {
    if (mode === 'production') {
      throw new Error(
        'SESSION_SECRET is required in production. Generate one with '
        + '`openssl rand -hex 32` and set it in your environment.',
      );
    }
    // Development only: a fresh secret per boot, so tokens die with the process.
    sessionSecret = randomBytes(32).toString('hex');
    console.warn('[config] SESSION_SECRET not set — using an ephemeral development secret');
  }
  if (mode === 'production' && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }

  const publicOrigin = env.PUBLIC_ORIGIN ?? null;

  return {
    env: mode,
    host: env.HOST ?? '0.0.0.0',
    port: int(env.PORT, 8080),
    publicOrigin,
    sessionSecret,
    databasePath: env.DATABASE_PATH ?? (mode === 'production' ? '/data/xiangqi.db' : './data/xiangqi.db'),
    staticDir: env.STATIC_DIR ?? (mode === 'production' ? '/app/public' : '../client/dist'),
    allowGuests: bool(env.ALLOW_GUESTS, true),
    rateAiGames: bool(env.RATE_AI_GAMES, true),
    undoMakesUnrated: bool(env.UNDO_MAKES_UNRATED, true),
    maxRooms: int(env.MAX_ROOMS, 200),
    maxRoomsPerUser: int(env.MAX_ROOMS_PER_USER, 3),
    roomIdleMs: int(env.ROOM_IDLE_MS, 15 * 60 * 1000),
    crossOriginIsolation: bool(env.CROSS_ORIGIN_ISOLATION, true),
    trustProxy: bool(env.TRUST_PROXY, true),
    logLevel: (env.LOG_LEVEL as Config['logLevel']) ?? 'info',
    maxConnectionsPerIp: int(env.MAX_CONNECTIONS_PER_IP, 24),
    leaderboardMinGames: int(env.LEADERBOARD_MIN_GAMES, 5),
    undoResponseTimeoutMs: int(env.UNDO_RESPONSE_TIMEOUT_MS, 30_000),
    aiReportCooldownMs: int(env.AI_REPORT_COOLDOWN_MS, 20_000),
    authRateLimit: int(env.AUTH_RATE_LIMIT, 20),
    authRateWindowMs: int(env.AUTH_RATE_WINDOW_MS, 60_000),
    // A Secure cookie is not sent over plain HTTP, so defaulting this on in
    // production is right — but it would also silently break a development
    // server on a LAN address, which is how the headset is usually pointed at a
    // laptop. Follow the origin when one is configured, the mode otherwise.
    secureCookies: bool(
      env.SECURE_COOKIES,
      publicOrigin ? publicOrigin.startsWith('https://') : mode === 'production',
    ),
    sessionPersistDays: Math.min(MAX_COOKIE_DAYS, Math.max(1, int(env.SESSION_PERSIST_DAYS, MAX_COOKIE_DAYS))),
    linkTtlMs: int(env.LINK_CODE_TTL_MS, 10 * 60 * 1000),
    linkPollIntervalMs: int(env.LINK_POLL_INTERVAL_MS, 2000),
  };
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export const createLogger = (level: Config['logLevel']) => {
  const threshold = LEVELS[level] ?? 20;
  const emit = (name: keyof typeof LEVELS, message: string, extra?: unknown) => {
    if (LEVELS[name] < threshold) return;
    const line = `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}`;
    if (extra === undefined) console.log(line);
    else console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
  };
  return {
    debug: (m: string, e?: unknown) => emit('debug', m, e),
    info: (m: string, e?: unknown) => emit('info', m, e),
    warn: (m: string, e?: unknown) => emit('warn', m, e),
    error: (m: string, e?: unknown) => emit('error', m, e),
  };
};

export type Logger = ReturnType<typeof createLogger>;
