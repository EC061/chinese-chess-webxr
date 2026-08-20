/**
 * Turning a search result into the move the AI actually plays.
 *
 * The search always finds the best move it can; the level knobs decide how
 * faithfully to follow it. Noise is applied to root scores rather than to the
 * evaluation itself, which keeps the AI's mistakes plausible — it picks a move
 * that is genuinely second- or third-best, not a nonsensical one.
 */
import { NO_MOVE, type Move, type Position } from '@ccx/shared';
import type { RootMoveScore } from './search.js';
import type { LevelSpec } from './levels.js';

/** How many candidates to try before giving up on dodging a mate-in-1. */
const MATE_FILTER_ATTEMPTS = 6;

export interface ChoiceResult {
  move: Move;
  /** The move the search actually rated best, for the analysis readout. */
  bestMove: Move;
  /** True when the level knobs made us deviate from the best move. */
  deviated: boolean;
}

export const chooseMove = (
  pos: Position,
  rootScores: RootMoveScore[],
  spec: LevelSpec,
  random: () => number = Math.random,
): ChoiceResult => {
  const scored = rootScores.filter((r) => r.move !== NO_MOVE && r.score > -32000);
  if (scored.length === 0) {
    const fallback = rootScores[0]?.move ?? NO_MOVE;
    return { move: fallback, bestMove: fallback, deviated: false };
  }

  const bestMove = scored.reduce((a, b) => (b.score > a.score ? b : a)).move;

  // A beginner-level blunder: ignore the search and play something legal.
  if (spec.blunderChance > 0 && random() < spec.blunderChance) {
    const shuffled = [...scored].sort(() => random() - 0.5);
    const move = pickSafe(pos, shuffled.map((s) => s.move), spec.avoidMateIn1);
    return { move, bestMove, deviated: move !== bestMove };
  }

  // Otherwise pick by noisy score, which can only ever deviate by evalNoise.
  const ranked = scored
    .map((r) => ({ move: r.move, key: r.score + (spec.evalNoise > 0 ? random() * spec.evalNoise : 0) }))
    .sort((a, b) => b.key - a.key)
    .map((r) => r.move);

  const move = pickSafe(pos, ranked, spec.avoidMateIn1);
  return { move, bestMove, deviated: move !== bestMove };
};

/**
 * Walk the candidate list until we find one that does not hand the opponent an
 * immediate mate. Only the first few candidates are checked — the point is to
 * stop the weak levels from throwing games away in one move, not to make them
 * strong.
 */
const pickSafe = (pos: Position, candidates: Move[], avoidMateIn1: boolean): Move => {
  if (!avoidMateIn1) return candidates[0] ?? NO_MOVE;
  const limit = Math.min(candidates.length, MATE_FILTER_ATTEMPTS);
  for (let i = 0; i < limit; i++) {
    const move = candidates[i]!;
    if (!allowsMateInOne(pos, move)) return move;
  }
  return candidates[0] ?? NO_MOVE;
};

/** Does playing `move` let the opponent mate on the very next move? */
export const allowsMateInOne = (pos: Position, move: Move): boolean => {
  if (!pos.tryMove(move)) return false;
  let mated = false;
  for (const reply of pos.generateMoves(pos.side)) {
    if (!pos.tryMove(reply)) continue;
    const weHaveMoves = pos.generateLegalMoves(pos.side).length > 0;
    pos.unmakeMove();
    if (!weHaveMoves) { mated = true; break; }
  }
  pos.unmakeMove();
  return mated;
};
