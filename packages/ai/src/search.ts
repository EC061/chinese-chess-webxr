/**
 * Alpha-beta searcher: iterative deepening, transposition table, killer and
 * history heuristics, MVV-LVA ordering, late move reductions, null-move
 * pruning, and a capture-only quiescence search with delta pruning.
 *
 * Two Xiangqi-specific rules shape the search:
 *  - Having no legal move is a loss, so "stalemate" scores as mate.
 *  - The general can be captured outright, which is why the general carries a
 *    huge material value and the search treats its loss as terminal.
 *
 * It is deliberately free of any DOM or Node API so it can be unit-tested
 * directly and run unchanged inside a Web Worker.
 */
import {
  BOARD_SIZE, EMPTY, NO_MOVE, Position, ZOB_SIDE_HI, ZOB_SIDE_LO, isCapture, moveFrom, moveTo,
  other, type Move,
} from '@ccx/shared';
import { DRAW_SCORE, MATE_SCORE, MATE_THRESHOLD, evaluate, hasAttackingMaterial, pieceValue } from './eval.js';
import { STOP_INDEX, TT_EXACT, TT_LOWER, TT_UPPER, TranspositionTable, type TtProbe } from './tt.js';

const MAX_PLY = 64;
const MAX_Q_PLY = 10;
const INFINITY = 32001;
const NODES_PER_TIME_CHECK = 2048;

export interface SearchLimits {
  /** Hard depth ceiling for the iterative deepening loop. */
  depth: number;
  /** Wall-clock budget in milliseconds. */
  timeMs: number;
  /** Optional node ceiling, mostly for reproducible tests. */
  nodes?: number;
}

export interface RootMoveScore {
  move: Move;
  score: number;
}

export interface SearchInfo {
  depth: number;
  score: number;
  nodes: number;
  timeMs: number;
  pv: Move[];
}

export interface SearchResult {
  bestMove: Move;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  pv: Move[];
  /** Every root move with its score, so the caller can pick a weaker one. */
  rootScores: RootMoveScore[];
  /** True if the search ran out of time mid-iteration. */
  aborted: boolean;
}

export interface SearcherOptions {
  tt?: TranspositionTable;
  /** Shared Int32Array whose STOP_INDEX word aborts every worker at once. */
  control?: Int32Array;
  /** Lazy-SMP helpers jitter their ordering so they explore different lines. */
  threadIndex?: number;
  onInfo?: (info: SearchInfo) => void;
  now?: () => number;
  /** Deterministic RNG hook, used by the tests. */
  random?: () => number;
}

const defaultNow = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class Searcher {
  readonly tt: TranspositionTable;
  private readonly control?: Int32Array;
  private readonly threadIndex: number;
  private readonly onInfo?: (info: SearchInfo) => void;
  private readonly now: () => number;
  private readonly random: () => number;

  private readonly killers = new Int32Array(MAX_PLY * 2);
  private readonly history = new Int32Array(BOARD_SIZE * BOARD_SIZE);
  private readonly buffers: Move[][] = [];
  /** Parallel ordering keys, so move ordering allocates nothing. */
  private readonly keyBuffers: Int32Array[] = [];
  private readonly probe: TtProbe = { hit: false, move: 0, score: 0, depth: 0, flag: 0 };
  private readonly pvTable: Move[][] = [];

  private pos!: Position;
  private nodes = 0;
  private deadline = 0;
  private nodeLimit = Infinity;
  private stopped = false;

  constructor(options: SearcherOptions = {}) {
    this.tt = options.tt ?? new TranspositionTable(16);
    this.control = options.control;
    this.threadIndex = options.threadIndex ?? 0;
    this.onInfo = options.onInfo;
    this.now = options.now ?? defaultNow;
    this.random = options.random ?? Math.random;
    for (let i = 0; i <= MAX_PLY + MAX_Q_PLY + 2; i++) {
      this.buffers.push([]);
      this.keyBuffers.push(new Int32Array(256));
      this.pvTable.push([]);
    }
  }

  /** Reset the heuristics that should not leak between games. */
  newGame(): void {
    this.tt.clear();
    this.history.fill(0);
    this.killers.fill(0);
  }

  search(position: Position, limits: SearchLimits): SearchResult {
    this.pos = position;
    this.nodes = 0;
    this.stopped = false;
    this.nodeLimit = limits.nodes ?? Infinity;
    const start = this.now();
    this.deadline = start + limits.timeMs;
    // Decay history rather than clearing it: last move's ordering is still useful.
    for (let i = 0; i < this.history.length; i++) this.history[i] = (this.history[i]! / 4) | 0;

    const rootMoves = position.generateLegalMoves(position.side);
    if (rootMoves.length === 0) {
      return {
        bestMove: NO_MOVE, score: -MATE_SCORE, depth: 0, nodes: 0,
        timeMs: 0, pv: [], rootScores: [], aborted: false,
      };
    }

    let best: SearchResult = {
      bestMove: rootMoves[0]!, score: 0, depth: 0, nodes: 0, timeMs: 0, pv: [rootMoves[0]!],
      rootScores: rootMoves.map((move) => ({ move, score: 0 })),
      aborted: false,
    };
    if (rootMoves.length === 1) {
      best.timeMs = this.now() - start;
      return best;
    }

    // Helper threads start one ply deeper so they diverge from the primary.
    const startDepth = 1 + (this.threadIndex > 0 ? this.threadIndex % 2 : 0);
    let ordered = rootMoves;

    for (let depth = startDepth; depth <= limits.depth; depth++) {
      const iteration = this.searchRoot(ordered, depth);
      if (this.stopped) {
        best.aborted = true;
        break;
      }
      ordered = iteration.rootScores.map((r) => r.move);
      best = {
        bestMove: iteration.bestMove,
        score: iteration.score,
        depth,
        nodes: this.nodes,
        timeMs: this.now() - start,
        pv: iteration.pv,
        rootScores: iteration.rootScores,
        aborted: false,
      };
      this.onInfo?.({ depth, score: best.score, nodes: this.nodes, timeMs: best.timeMs, pv: best.pv });

      // A forced mate needs no further searching.
      if (Math.abs(best.score) > MATE_THRESHOLD) break;
      // Do not start an iteration we have no hope of finishing.
      if (this.now() - start > limits.timeMs * 0.5) break;
    }

    best.nodes = this.nodes;
    best.timeMs = this.now() - start;
    return best;
  }

  private searchRoot(moves: Move[], depth: number): {
    bestMove: Move; score: number; pv: Move[]; rootScores: RootMoveScore[];
  } {
    let alpha = -INFINITY;
    const beta = INFINITY;
    let bestMove = moves[0]!;
    let bestPv: Move[] = [bestMove];
    const scores: RootMoveScore[] = [];

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i]!;
      if (!this.pos.tryMove(move)) continue;
      let score: number;
      if (i === 0) {
        score = -this.alphaBeta(depth - 1, -beta, -alpha, 1, true);
      } else {
        // Principal variation search: prove the rest are worse, cheaply.
        score = -this.alphaBeta(depth - 1, -alpha - 1, -alpha, 1, true);
        if (score > alpha && !this.stopped) {
          score = -this.alphaBeta(depth - 1, -beta, -alpha, 1, true);
        }
      }
      this.pos.unmakeMove();

      if (this.stopped) break;
      scores.push({ move, score });
      if (score > alpha) {
        alpha = score;
        bestMove = move;
        bestPv = [move, ...this.pvTable[1]!];
      }
    }

    scores.sort((a, b) => b.score - a.score);
    // Any move we never got to score keeps its previous ordering, behind the rest.
    for (const move of moves) {
      if (!scores.some((s) => s.move === move)) scores.push({ move, score: -INFINITY });
    }
    return { bestMove, score: alpha, pv: bestPv, rootScores: scores };
  }

  private checkTime(): void {
    if (this.nodes % NODES_PER_TIME_CHECK !== 0) return;
    if (this.nodes > this.nodeLimit) { this.stopped = true; return; }
    if (this.now() >= this.deadline) { this.stopped = true; return; }
    if (this.control && this.control[STOP_INDEX] !== 0) this.stopped = true;
  }

  private alphaBeta(depth: number, alphaIn: number, beta: number, ply: number, canNull: boolean): number {
    const pos = this.pos;
    this.pvTable[ply]!.length = 0;
    let alpha = alphaIn;

    this.nodes++;
    this.checkTime();
    if (this.stopped) return 0;

    // A repeated position or a long capture-free stretch is a draw.
    if (ply > 0) {
      if (pos.repetitionCount() >= 2) return DRAW_SCORE;
      if (pos.halfmoveClock >= 120) return DRAW_SCORE;
    }
    if (ply >= MAX_PLY) return evaluate(pos);

    const inCheck = pos.inCheck(pos.side);
    // Extend when in check rather than dropping straight into quiescence.
    if (inCheck && depth < 1) depth = 1;
    if (depth <= 0) return this.quiescence(alpha, beta, ply, 0);

    const probe = this.tt.probe(pos.hashLo, pos.hashHi, this.probe);
    let ttMove = NO_MOVE;
    if (probe.hit) {
      ttMove = probe.move;
      if (probe.depth >= depth) {
        const score = fromTtScore(probe.score, ply);
        if (probe.flag === TT_EXACT) return score;
        if (probe.flag === TT_LOWER && score >= beta) return score;
        if (probe.flag === TT_UPPER && score <= alpha) return score;
      }
    }

    // Null-move pruning: if giving the opponent a free move still leaves us
    // above beta, this node is not worth exploring. Skipped in check and when
    // we have no attacking material, where zugzwang is a real risk.
    if (canNull && !inCheck && depth >= 3 && beta < MATE_THRESHOLD
      && hasAttackingMaterial(pos, pos.side)) {
      const R = 2 + ((depth / 6) | 0);
      this.makeNull();
      const score = -this.alphaBeta(depth - 1 - R, -beta, -beta + 1, ply + 1, false);
      this.unmakeNull();
      if (this.stopped) return 0;
      if (score >= beta) return beta;
    }

    const moves = this.buffers[ply]!;
    moves.length = 0;
    pos.generateMoves(pos.side, false, moves);
    const keys = this.scoreMoves(moves, ttMove, ply);

    let bestScore = -INFINITY;
    let bestMove = NO_MOVE;
    let legal = 0;
    let searched = 0;

    for (let index = 0; index < moves.length; index++) {
      // Selection sort on demand: after a cutoff the tail is never ordered.
      pickBest(moves, keys, index);
      const move = moves[index]!;
      if (!pos.tryMove(move)) continue;
      legal++;

      const capture = isCapture(move);
      let score: number;

      // Late move reductions: quiet moves late in a well-ordered list are
      // searched shallower first, and re-searched only if they surprise us.
      // `givesCheck` is only computed when a reduction is actually on the table.
      let reduction = 0;
      if (depth >= 3 && searched >= 3 && !capture && !inCheck && !pos.inCheck(pos.side)) {
        reduction = searched >= 8 ? 2 : 1;
        if (reduction >= depth) reduction = depth - 1;
      }

      if (searched === 0) {
        score = -this.alphaBeta(depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        score = -this.alphaBeta(depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && (reduction > 0 || score < beta)) {
          score = -this.alphaBeta(depth - 1, -beta, -alpha, ply + 1, true);
        }
      }
      pos.unmakeMove();
      searched++;

      if (this.stopped) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (score > alpha) {
          alpha = score;
          const child = this.pvTable[ply + 1]!;
          const pv = this.pvTable[ply]!;
          pv.length = 0;
          pv.push(move, ...child);
        }
        if (alpha >= beta) {
          if (!capture) {
            this.recordKiller(move, ply);
            const h = moveFrom(move) * BOARD_SIZE + moveTo(move);
            this.history[h] = Math.min(1 << 20, this.history[h]! + depth * depth);
          }
          break;
        }
      }
    }

    // No legal move at all loses the game in Xiangqi, checked or not.
    if (legal === 0) return -MATE_SCORE + ply;

    const flag = bestScore <= alphaIn ? TT_UPPER : alpha >= beta ? TT_LOWER : TT_EXACT;
    this.tt.store(pos.hashLo, pos.hashHi, bestMove, toTtScore(bestScore, ply), depth, flag);
    return bestScore;
  }

  private quiescence(alphaIn: number, beta: number, ply: number, qply: number): number {
    const pos = this.pos;
    this.pvTable[ply]!.length = 0;
    let alpha = alphaIn;

    this.nodes++;
    this.checkTime();
    if (this.stopped) return 0;

    const inCheck = pos.inCheck(pos.side);
    let standPat = -INFINITY;
    if (!inCheck) {
      standPat = evaluate(pos);
      if (standPat >= beta) return standPat;
      if (standPat > alpha) alpha = standPat;
    }
    if (qply >= MAX_Q_PLY || ply >= MAX_PLY) return inCheck ? evaluate(pos) : standPat;

    const slot = Math.min(ply, this.buffers.length - 1);
    const moves = this.buffers[slot]!;
    moves.length = 0;
    // In check we must consider every escape, not just captures.
    pos.generateMoves(pos.side, !inCheck, moves);
    const keys = this.scoreMoves(moves, NO_MOVE, slot);

    let best = standPat;
    let legal = 0;
    for (let index = 0; index < moves.length; index++) {
      pickBest(moves, keys, index);
      const move = moves[index]!;
      // Delta pruning: a capture that cannot possibly reach alpha is skipped.
      if (!inCheck) {
        const gain = pieceValue(moveCapturedPiece(pos, move));
        if (standPat + gain + 120 <= alpha) continue;
      }
      if (!pos.tryMove(move)) continue;
      legal++;
      const score = -this.quiescence(-beta, -alpha, ply + 1, qply + 1);
      pos.unmakeMove();
      if (this.stopped) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) alpha = score;
        if (alpha >= beta) break;
      }
    }

    if (inCheck && legal === 0) return -MATE_SCORE + ply;
    return best;
  }

  private recordKiller(move: Move, ply: number): void {
    const i = ply * 2;
    if (this.killers[i] === move) return;
    this.killers[i + 1] = this.killers[i]!;
    this.killers[i] = move;
  }

  /**
   * Fill the parallel key array used to order `moves`. Captures come first by
   * most-valuable-victim / least-valuable-attacker, then killers, then the
   * history heuristic. Nothing is allocated.
   */
  private scoreMoves(moves: Move[], ttMove: Move, ply: number): Int32Array {
    const pos = this.pos;
    const keys = this.keyBuffers[ply]!;
    const killer0 = this.killers[ply * 2]!;
    const killer1 = this.killers[ply * 2 + 1]!;
    // Helper threads perturb ordering slightly so the shared table fills with a
    // wider spread of lines than a single thread would produce.
    const jitter = this.threadIndex > 0 ? this.threadIndex * 7 : 0;

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i]!;
      if (move === ttMove) {
        keys[i] = 1 << 26;
        continue;
      }
      const captured = pos.pieceAt((move >> 7) & 0x7f);
      if (captured !== EMPTY) {
        const victim = pieceValue(captured);
        const attacker = pieceValue(pos.pieceAt(move & 0x7f));
        keys[i] = (1 << 22) + victim * 8 - attacker;
        continue;
      }
      if (move === killer0) { keys[i] = 1 << 21; continue; }
      if (move === killer1) { keys[i] = (1 << 21) - 1; continue; }
      const h = this.history[(move & 0x7f) * BOARD_SIZE + ((move >> 7) & 0x7f)]!;
      keys[i] = jitter ? h + ((move * 2654435761) % jitter) : h;
    }
    return keys;
  }

  /**
   * Pass the turn without touching the move history. Legal here because the
   * searcher owns the position for the duration of the search.
   */
  private makeNull(): void {
    const pos = this.pos;
    pos.side = other(pos.side);
    pos.hashLo ^= ZOB_SIDE_LO;
    pos.hashHi ^= ZOB_SIDE_HI;
  }

  private unmakeNull(): void {
    this.makeNull();
  }
}

const moveCapturedPiece = (pos: Position, move: Move): number => pos.pieceAt(moveTo(move));

/** Swap the highest-keyed remaining move into `index`. */
const pickBest = (moves: Move[], keys: Int32Array, index: number): void => {
  let bestIndex = index;
  let bestKey = keys[index]!;
  for (let j = index + 1; j < moves.length; j++) {
    const key = keys[j]!;
    if (key > bestKey) { bestKey = key; bestIndex = j; }
  }
  if (bestIndex === index) return;
  const move = moves[index]!;
  moves[index] = moves[bestIndex]!;
  moves[bestIndex] = move;
  keys[bestIndex] = keys[index]!;
  keys[index] = bestKey;
};

/** Mate scores are stored relative to the node, not the root. */
const toTtScore = (score: number, ply: number): number => {
  if (score > MATE_THRESHOLD) return score + ply;
  if (score < -MATE_THRESHOLD) return score - ply;
  return score;
};

const fromTtScore = (score: number, ply: number): number => {
  if (score > MATE_THRESHOLD) return score - ply;
  if (score < -MATE_THRESHOLD) return score + ply;
  return score;
};

/** Turn a mate score into "mate in N moves", or null if it is not a mate. */
export const mateDistance = (score: number): number | null => {
  const abs = Math.abs(score);
  if (abs <= MATE_THRESHOLD) return null;
  const plies = MATE_SCORE - abs;
  return Math.sign(score) * Math.ceil(plies / 2);
};
