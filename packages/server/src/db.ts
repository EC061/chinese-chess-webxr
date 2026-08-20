/**
 * Storage, on `node:sqlite` in WAL mode.
 *
 * WAL matters here because the write pattern is many small writes (a row per
 * finished game, a rating update per player) against continuous reads for the
 * lobby and leaderboard; WAL lets those readers proceed without blocking on the
 * writer. `node:sqlite` is built into Node, which keeps the container free of
 * native build tooling.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_RATING, PROVISIONAL_RD, type Rating } from '@ccx/shared';

/**
 * `node:sqlite` is newer than the builtin list some bundlers ship with, and a
 * static import gets rewritten to a bare `sqlite` specifier that resolves to
 * nothing. Going through createRequire keeps the runtime import opaque to any
 * bundler while the type-only import above keeps full type checking.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

export interface UserRow {
  id: string;
  name: string;
  password_hash: string | null;
  guest: number;
  rating: number;
  rd: number;
  volatility: number;
  wins: number;
  losses: number;
  draws: number;
  ai_wins: number;
  ai_losses: number;
  ai_draws: number;
  created_at: number;
  last_seen: number;
}

export interface GameRow {
  id: string;
  mode: 'pvp' | 'ai';
  red_id: string | null;
  black_id: string | null;
  ai_level: number | null;
  result: 'red' | 'black' | 'draw';
  reason: string;
  rated: number;
  start_fen: string;
  moves: string;
  red_rating_before: number | null;
  red_rating_after: number | null;
  black_rating_before: number | null;
  black_rating_after: number | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT,
  guest         INTEGER NOT NULL DEFAULT 0,
  rating        REAL NOT NULL,
  rd            REAL NOT NULL,
  volatility    REAL NOT NULL,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  ai_wins       INTEGER NOT NULL DEFAULT 0,
  ai_losses     INTEGER NOT NULL DEFAULT 0,
  ai_draws      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

-- Names are unique case-insensitively, so "Ling" and "ling" cannot both exist.
CREATE UNIQUE INDEX IF NOT EXISTS users_name_unique ON users (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS users_rating ON users (rating DESC);

CREATE TABLE IF NOT EXISTS games (
  id                   TEXT PRIMARY KEY,
  mode                 TEXT NOT NULL,
  red_id               TEXT,
  black_id             TEXT,
  ai_level             INTEGER,
  result               TEXT NOT NULL,
  reason               TEXT NOT NULL,
  rated                INTEGER NOT NULL,
  start_fen            TEXT NOT NULL,
  moves                TEXT NOT NULL,
  red_rating_before    REAL,
  red_rating_after     REAL,
  black_rating_before  REAL,
  black_rating_after   REAL,
  created_at           INTEGER NOT NULL,
  FOREIGN KEY (red_id) REFERENCES users (id) ON DELETE SET NULL,
  FOREIGN KEY (black_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS games_created ON games (created_at DESC);
CREATE INDEX IF NOT EXISTS games_red ON games (red_id, created_at DESC);
CREATE INDEX IF NOT EXISTS games_black ON games (black_id, created_at DESC);
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL for concurrent readers; NORMAL sync is the right trade for a game
    // ladder, where losing the last few milliseconds on a hard crash is fine.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    // A truncating checkpoint leaves the -wal file empty, which makes the
    // volume safe to snapshot or copy between deploys.
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* closing anyway */ }
    this.db.close();
  }

  // --------------------------------------------------------------- users ---

  createUser(name: string, passwordHash: string | null, guest: boolean): UserRow {
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO users (id, name, password_hash, guest, rating, rd, volatility, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, passwordHash, guest ? 1 : 0,
      DEFAULT_RATING.rating, DEFAULT_RATING.rd, DEFAULT_RATING.volatility, now, now,
    );
    return this.userById(id)!;
  }

  userById(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined) ?? null;
  }

  userByName(name: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE').get(name) as unknown as UserRow | undefined) ?? null;
  }

  touchUser(id: string): void {
    this.db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  ratingOf(user: UserRow): Rating {
    return { rating: user.rating, rd: user.rd, volatility: user.volatility };
  }

  applyRating(id: string, rating: Rating): void {
    this.db.prepare('UPDATE users SET rating = ?, rd = ?, volatility = ? WHERE id = ?')
      .run(rating.rating, rating.rd, rating.volatility, id);
  }

  recordOutcome(id: string, mode: 'pvp' | 'ai', outcome: 'win' | 'loss' | 'draw'): void {
    const column = mode === 'ai'
      ? { win: 'ai_wins', loss: 'ai_losses', draw: 'ai_draws' }[outcome]
      : { win: 'wins', loss: 'losses', draw: 'draws' }[outcome];
    this.db.prepare(`UPDATE users SET ${column} = ${column} + 1 WHERE id = ?`).run(id);
  }

  renameGuest(id: string, name: string): void {
    this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
  }

  /** Ladder, excluding guests and anyone with too few games to be meaningful. */
  leaderboard(limit: number, minGames: number): UserRow[] {
    return this.db.prepare(`
      SELECT * FROM users
      WHERE guest = 0
        AND (wins + losses + draws + ai_wins + ai_losses + ai_draws) >= ?
      ORDER BY rating DESC
      LIMIT ?
    `).all(minGames, limit) as unknown as UserRow[];
  }

  // --------------------------------------------------------------- games ---

  recordGame(game: Omit<GameRow, 'created_at'> & { created_at?: number }): void {
    this.db.prepare(`
      INSERT INTO games (
        id, mode, red_id, black_id, ai_level, result, reason, rated, start_fen, moves,
        red_rating_before, red_rating_after, black_rating_before, black_rating_after, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      game.id, game.mode, game.red_id, game.black_id, game.ai_level, game.result, game.reason,
      game.rated, game.start_fen, game.moves,
      game.red_rating_before, game.red_rating_after, game.black_rating_before,
      game.black_rating_after, game.created_at ?? Date.now(),
    );
  }

  recentGames(userId: string, limit: number): GameRow[] {
    return this.db.prepare(`
      SELECT * FROM games
      WHERE red_id = ? OR black_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, userId, limit) as unknown as GameRow[];
  }

  /** When the same player last reported an AI game, for rate limiting. */
  lastAiReportAt(userId: string): number {
    const row = this.db.prepare(`
      SELECT created_at FROM games
      WHERE mode = 'ai' AND (red_id = ? OR black_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(userId, userId) as unknown as { created_at: number } | undefined;
    return row?.created_at ?? 0;
  }

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as unknown as { n: number }).n;
  }

  countGames(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM games').get() as unknown as { n: number }).n;
  }

  /** Remove guest accounts with no games that have not been seen in a while. */
  pruneGuests(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db.prepare(`
      DELETE FROM users
      WHERE guest = 1 AND last_seen < ?
        AND id NOT IN (SELECT red_id FROM games WHERE red_id IS NOT NULL)
        AND id NOT IN (SELECT black_id FROM games WHERE black_id IS NOT NULL)
    `).run(cutoff);
    return Number(result.changes);
  }
}

export const isProvisionalRow = (user: UserRow): boolean => user.rd > PROVISIONAL_RD;
