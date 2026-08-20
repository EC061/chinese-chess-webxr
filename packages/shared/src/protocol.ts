/**
 * Wire protocol. Every inbound message is parsed with zod on the server, so a
 * malformed or hostile client is rejected before it reaches any game logic.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const LANGS = ['zh', 'en'] as const;
export const SideChoice = z.enum(['red', 'black', 'random']);
export type SideChoice = z.infer<typeof SideChoice>;

export const AI_LEVEL_MIN = 1;
export const AI_LEVEL_MAX = 8;

export const TimeControl = z.object({
  /** Base thinking time per player, in seconds. */
  initialSeconds: z.number().int().min(30).max(7200),
  /** Fischer increment added after each move, in seconds. */
  incrementSeconds: z.number().int().min(0).max(120),
});
export type TimeControl = z.infer<typeof TimeControl>;

export const ROOM_NAME_MAX = 40;
export const PASSCODE_PATTERN = /^[0-9]{4,8}$/;

/** Numeric passcodes only — they have to be typed on a VR keypad. */
export const Passcode = z.string().regex(PASSCODE_PATTERN, 'passcode must be 4-8 digits');

export const EMOTES = [
  'good-move', 'thinking', 'hello', 'good-game', 'oops', 'nice', 'hurry', 'rematch',
] as const;
export type Emote = (typeof EMOTES)[number];

// ------------------------------------------------------------ client -> server

export const ClientMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ping'), at: z.number().optional() }),

  z.object({ t: z.literal('lobby:subscribe') }),
  z.object({ t: z.literal('lobby:unsubscribe') }),
  z.object({ t: z.literal('leaderboard:get'), limit: z.number().int().min(1).max(100).optional() }),

  z.object({
    t: z.literal('room:create'),
    name: z.string().trim().min(1).max(ROOM_NAME_MAX),
    passcode: Passcode.optional(),
    side: SideChoice.default('random'),
    rated: z.boolean().default(true),
    timeControl: TimeControl.nullable().default(null),
    /** Allow spectators to watch. */
    open: z.boolean().default(true),
  }),
  z.object({ t: z.literal('room:join'), roomId: z.string(), passcode: z.string().optional() }),
  z.object({ t: z.literal('room:spectate'), roomId: z.string(), passcode: z.string().optional() }),
  z.object({ t: z.literal('room:leave') }),
  z.object({ t: z.literal('room:emote'), emote: z.enum(EMOTES) }),
  /** Seat/pose sync so each player sees the other lean over the board. */
  z.object({
    t: z.literal('room:pose'),
    head: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
    hands: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])).max(2),
  }),

  z.object({ t: z.literal('game:move'), iccs: z.string().length(4) }),
  /** Live drag feedback: show the opponent the piece being lifted. */
  z.object({ t: z.literal('game:grab'), square: z.number().int().min(-1).max(89) }),
  z.object({ t: z.literal('game:resign') }),
  z.object({ t: z.literal('game:undo-request') }),
  z.object({ t: z.literal('game:undo-response'), accept: z.boolean() }),
  z.object({ t: z.literal('game:draw-offer') }),
  z.object({ t: z.literal('game:draw-response'), accept: z.boolean() }),
  z.object({ t: z.literal('game:rematch') }),

  /**
   * Result of a game played against the client-side AI. The server replays the
   * move list through the same rules engine before it will rate anything.
   */
  z.object({
    t: z.literal('ai:report'),
    level: z.number().int().min(AI_LEVEL_MIN).max(AI_LEVEL_MAX),
    playerColor: z.enum(['red', 'black']),
    moves: z.array(z.string().length(4)).max(600),
    result: z.enum(['red', 'black', 'draw']),
    /** Undos used — any undo makes the game unrated. */
    undos: z.number().int().min(0).max(999).default(0),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ------------------------------------------------------------ server -> client

export interface PublicUser {
  id: string;
  name: string;
  rating: number;
  rd: number;
  provisional: boolean;
  guest: boolean;
}

export interface RoomSummary {
  id: string;
  name: string;
  hasPasscode: boolean;
  rated: boolean;
  open: boolean;
  timeControl: TimeControl | null;
  host: PublicUser;
  /** Seated players, in [red, black] order; null means the seat is open. */
  seats: [PublicUser | null, PublicUser | null];
  spectators: number;
  status: 'waiting' | 'playing' | 'finished';
  createdAt: number;
}

export interface MoveRecord {
  iccs: string;
  zh: string;
  en: string;
  /** Milliseconds the mover spent on it. */
  ms: number;
}

export interface Clocks {
  redMs: number;
  blackMs: number;
  /** Server timestamp the running clock was last updated. */
  updatedAt: number;
  running: 'red' | 'black' | null;
}

export interface GameState {
  fen: string;
  moves: MoveRecord[];
  turn: 'red' | 'black';
  inCheck: boolean;
  over: { result: 'red' | 'black' | 'draw'; reason: string } | null
  clocks: Clocks | null;
}

export interface RatingChange {
  userId: string;
  before: number;
  after: number;
}

export type ServerMessage =
  | { t: 'hello'; version: number; user: PublicUser }
  | { t: 'pong'; at?: number }
  | { t: 'error'; code: string; message: string }
  | { t: 'lobby:rooms'; rooms: RoomSummary[] }
  | { t: 'leaderboard'; entries: Array<PublicUser & { wins: number; losses: number; draws: number; aiWins: number }> }
  | { t: 'room:joined'; room: RoomSummary; you: 'red' | 'black' | 'spectator' }
  | { t: 'room:state'; room: RoomSummary }
  | { t: 'room:left' }
  | { t: 'room:emote'; from: string; emote: Emote }
  | { t: 'room:pose'; from: string; head: number[]; hands: number[][] }
  | { t: 'game:state'; state: GameState }
  | { t: 'game:grab'; from: string; square: number }
  | { t: 'game:undo-requested'; by: string; byName: string }
  | { t: 'game:undo-result'; accepted: boolean; by: string }
  | { t: 'game:draw-offered'; by: string; byName: string }
  | { t: 'game:draw-result'; accepted: boolean; by: string }
  | { t: 'game:over'; result: 'red' | 'black' | 'draw'; reason: string; ratings: RatingChange[] }
  | { t: 'ai:rated'; rating: RatingChange | null; reason?: string };

export const ERROR_CODES = {
  BAD_MESSAGE: 'BAD_MESSAGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  BAD_PASSCODE: 'BAD_PASSCODE',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  ILLEGAL_MOVE: 'ILLEGAL_MOVE',
  GAME_NOT_ACTIVE: 'GAME_NOT_ACTIVE',
  NO_PENDING_REQUEST: 'NO_PENDING_REQUEST',
  ALREADY_PENDING: 'ALREADY_PENDING',
  NOTHING_TO_UNDO: 'NOTHING_TO_UNDO',
  RATE_LIMITED: 'RATE_LIMITED',
  TOO_MANY_ROOMS: 'TOO_MANY_ROOMS',
  INVALID_GAME: 'INVALID_GAME',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
