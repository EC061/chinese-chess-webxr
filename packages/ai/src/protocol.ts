/** Messages exchanged with the search workers. */
import type { LevelSpec } from './levels.js';

export interface WorkerInit {
  cmd: 'init';
  threadIndex: number;
  /** Shared transposition table, when the page is cross-origin isolated. */
  ttBuffer?: SharedArrayBuffer;
  /** Shared control block whose first word is the stop flag. */
  controlBuffer?: SharedArrayBuffer;
  ttSizeMb: number;
}

export interface WorkerSearch {
  cmd: 'search';
  id: number;
  startFen: string;
  /** ICCS moves replayed from startFen, so repetition history is exact. */
  moves: string[];
  level: number;
  /** Overrides for analysis/hint searches. */
  limits?: { depth?: number; timeMs?: number };
  /** Only the primary thread applies the level's noise and reports a choice. */
  primary: boolean;
}

export interface WorkerStop {
  cmd: 'stop';
}

export interface WorkerNewGame {
  cmd: 'newgame';
}

export type WorkerRequest = WorkerInit | WorkerSearch | WorkerStop | WorkerNewGame;

export interface SearchLine {
  iccs: string;
  score: number;
}

export interface WorkerResult {
  type: 'result';
  id: number;
  /** The move to play, after the level's noise and blunder knobs. */
  iccs: string;
  /** The move the search rated best, regardless of level. */
  bestIccs: string;
  deviated: boolean;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  pv: string[];
  mateIn: number | null;
  rootScores: SearchLine[];
}

export interface WorkerProgress {
  type: 'progress';
  id: number;
  depth: number;
  score: number;
  nodes: number;
  timeMs: number;
  pv: string[];
}

export interface WorkerReady {
  type: 'ready';
  threadIndex: number;
  shared: boolean;
}

export type WorkerResponse = WorkerResult | WorkerProgress | WorkerReady;

export type { LevelSpec };
