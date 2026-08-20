/**
 * Authoritative Xiangqi position: move generation, legality, and game end.
 * The server and every client run this exact file, so a move accepted by one
 * is accepted by all.
 *
 * This is also the AI's inner loop, so the hot paths (generateMoves, isAttacked,
 * makeMove/unmakeMove) are written to allocate nothing: the undo stack lives in
 * preallocated typed arrays and every table walk is an indexed loop.
 */
import {
  ADVISOR_ATTACKS, ADVISOR_STEPS, ELEPHANT_ATTACKS, ELEPHANT_STEPS, GENERAL_ATTACKS,
  GENERAL_STEPS, HORSE_ATTACKS, HORSE_STEPS, RAY_START, RAY_TO, SOLDIER_ATTACKS, SOLDIER_STEPS,
  type StepTable,
} from './tables.js';
import { ZOB_HI, ZOB_LO, ZOB_SIDE_HI, ZOB_SIDE_LO, zobIndex } from './zobrist.js';
import {
  ADVISOR, BLACK, BOARD_SIZE, CANNON, CHARIOT, ELEPHANT, EMPTY, GENERAL, HORSE, NO_MOVE, RED,
  SOLDIER, colorOf, encodeMove, idx, makePiece, moveCaptured, moveFrom, moveTo, other, typeOf,
  type Color, type GameOver, type Move, type Piece,
} from './types.js';

/** Plies without a capture after which the game is drawn (60 full moves). */
export const NO_CAPTURE_PLY_LIMIT = 120;

/** Initial undo-stack depth; grown on demand for very long games. */
const INITIAL_STACK = 512;

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';

export class Position {
  readonly board: Int8Array = new Int8Array(BOARD_SIZE);
  side: Color = RED;
  hashLo = 0;
  hashHi = 0;
  halfmoveClock = 0;
  fullmoveNumber = 1;
  readonly generalSq: [number, number] = [-1, -1];

  /** Undo stack, as parallel typed arrays so making a move allocates nothing. */
  private stackMove = new Int32Array(INITIAL_STACK);
  private stackHashLo = new Int32Array(INITIAL_STACK);
  private stackHashHi = new Int32Array(INITIAL_STACK);
  private stackClock = new Int32Array(INITIAL_STACK);
  private stackCheck = new Uint8Array(INITIAL_STACK);
  private ply = 0;

  static fromFen(fen: string = START_FEN): Position {
    const p = new Position();
    p.setFen(fen);
    return p;
  }

  /** Number of moves played from the position's starting point. */
  get plies(): number {
    return this.ply;
  }

  moveAt(index: number): Move {
    return index >= 0 && index < this.ply ? this.stackMove[index]! : NO_MOVE;
  }

  /** Did the move at `index` leave the opponent in check? (See 长将.) */
  gaveCheckAt(index: number): boolean {
    return index >= 0 && index < this.ply && this.stackCheck[index] === 1;
  }

  movesPlayed(): Move[] {
    const out: Move[] = [];
    for (let i = 0; i < this.ply; i++) out.push(this.stackMove[i]!);
    return out;
  }

  clone(): Position {
    const p = new Position();
    p.board.set(this.board);
    p.side = this.side;
    p.hashLo = this.hashLo;
    p.hashHi = this.hashHi;
    p.halfmoveClock = this.halfmoveClock;
    p.fullmoveNumber = this.fullmoveNumber;
    p.generalSq[0] = this.generalSq[0];
    p.generalSq[1] = this.generalSq[1];
    p.growStack(this.ply);
    p.stackMove.set(this.stackMove.subarray(0, this.ply));
    p.stackHashLo.set(this.stackHashLo.subarray(0, this.ply));
    p.stackHashHi.set(this.stackHashHi.subarray(0, this.ply));
    p.stackClock.set(this.stackClock.subarray(0, this.ply));
    p.stackCheck.set(this.stackCheck.subarray(0, this.ply));
    p.ply = this.ply;
    return p;
  }

  pieceAt(square: number): Piece {
    return this.board[square]!;
  }

  private growStack(needed: number): void {
    if (needed < this.stackMove.length) return;
    const size = Math.max(needed + 1, this.stackMove.length * 2);
    const grow = (a: Int32Array) => {
      const next = new Int32Array(size);
      next.set(a);
      return next;
    };
    this.stackMove = grow(this.stackMove);
    this.stackHashLo = grow(this.stackHashLo);
    this.stackHashHi = grow(this.stackHashHi);
    this.stackClock = grow(this.stackClock);
    const checks = new Uint8Array(size);
    checks.set(this.stackCheck);
    this.stackCheck = checks;
  }

  // ---------------------------------------------------------------- FEN -----

  setFen(fen: string): void {
    this.board.fill(EMPTY);
    this.ply = 0;
    this.generalSq[0] = -1;
    this.generalSq[1] = -1;

    const parts = fen.trim().split(/\s+/);
    const placement = parts[0];
    const active = parts[1] ?? 'w';
    if (!placement) throw new Error('invalid FEN: empty placement');

    const ranks = placement.split('/');
    if (ranks.length !== 10) throw new Error(`invalid FEN: expected 10 ranks, got ${ranks.length}`);

    for (let row = 0; row < 10; row++) {
      let col = 0;
      for (const ch of ranks[row]!) {
        if (ch >= '1' && ch <= '9') {
          col += Number(ch);
          continue;
        }
        if (col > 8) throw new Error(`invalid FEN: rank ${row} overflows`);
        const piece = FEN_TO_PIECE[ch];
        if (piece === undefined) throw new Error(`invalid FEN: unknown piece '${ch}'`);
        this.board[idx(row, col)] = piece;
        if (typeOf(piece) === GENERAL) this.generalSq[colorOf(piece)] = idx(row, col);
        col++;
      }
    }

    this.side = active === 'b' ? BLACK : RED;
    this.halfmoveClock = Number(parts[4]) || 0;
    this.fullmoveNumber = Number(parts[5]) || 1;
    this.recomputeHash();
  }

  toFen(): string {
    const ranks: string[] = [];
    for (let row = 0; row < 10; row++) {
      let s = '';
      let run = 0;
      for (let col = 0; col < 9; col++) {
        const p = this.board[idx(row, col)]!;
        if (p === EMPTY) {
          run++;
        } else {
          if (run) { s += String(run); run = 0; }
          s += PIECE_TO_FEN[p];
        }
      }
      if (run) s += String(run);
      ranks.push(s);
    }
    return `${ranks.join('/')} ${this.side === RED ? 'w' : 'b'} - - ${this.halfmoveClock} ${this.fullmoveNumber}`;
  }

  private recomputeHash(): void {
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      const p = this.board[sq]!;
      if (p === EMPTY) continue;
      const z = zobIndex(p, sq);
      lo ^= ZOB_LO[z]!;
      hi ^= ZOB_HI[z]!;
    }
    if (this.side === BLACK) { lo ^= ZOB_SIDE_LO; hi ^= ZOB_SIDE_HI; }
    this.hashLo = lo | 0;
    this.hashHi = hi | 0;
  }

  // ------------------------------------------------------ move generation ---

  /**
   * All pseudo-legal moves for `color` (defaults to the side to move).
   * Pseudo-legal means shape-correct but possibly leaving one's own general
   * exposed — {@link tryMove} filters that.
   */
  generateMoves(color: Color = this.side, capturesOnly = false, out: Move[] = []): Move[] {
    const b = this.board;
    for (let from = 0; from < BOARD_SIZE; from++) {
      const piece = b[from]!;
      if (piece === EMPTY || (piece >> 3) !== color) continue;

      switch (piece & 7) {
        case GENERAL:
          this.pushSteps(GENERAL_STEPS[color], from, color, capturesOnly, out);
          break;
        case ADVISOR:
          this.pushSteps(ADVISOR_STEPS[color], from, color, capturesOnly, out);
          break;
        case SOLDIER:
          this.pushSteps(SOLDIER_STEPS[color], from, color, capturesOnly, out);
          break;
        case ELEPHANT:
          this.pushSteps(ELEPHANT_STEPS[color], from, color, capturesOnly, out);
          break;
        case HORSE:
          this.pushSteps(HORSE_STEPS, from, color, capturesOnly, out);
          break;
        case CHARIOT: {
          const base = from << 2;
          for (let d = 0; d < 4; d++) {
            const end = RAY_START[base + d + 1]!;
            for (let i = RAY_START[base + d]!; i < end; i++) {
              const to = RAY_TO[i]!;
              const target = b[to]!;
              if (target === EMPTY) {
                if (!capturesOnly) out.push(from | (to << 7));
                continue;
              }
              if ((target >> 3) !== color) out.push(from | (to << 7) | (target << 14));
              break;
            }
          }
          break;
        }
        case CANNON: {
          const base = from << 2;
          for (let d = 0; d < 4; d++) {
            const end = RAY_START[base + d + 1]!;
            let jumped = false;
            for (let i = RAY_START[base + d]!; i < end; i++) {
              const to = RAY_TO[i]!;
              const target = b[to]!;
              if (!jumped) {
                if (target === EMPTY) {
                  if (!capturesOnly) out.push(from | (to << 7));
                } else {
                  jumped = true; // this piece is the 炮架 (screen)
                }
                continue;
              }
              if (target === EMPTY) continue;
              if ((target >> 3) !== color) out.push(from | (to << 7) | (target << 14));
              break;
            }
          }
          break;
        }
      }
    }
    return out;
  }

  private pushSteps(
    table: StepTable, from: number, color: Color, capturesOnly: boolean, out: Move[],
  ): void {
    const b = this.board;
    const end = table.start[from + 1]!;
    for (let i = table.start[from]!; i < end; i++) {
      const block = table.block[i]!;
      if (block >= 0 && b[block] !== EMPTY) continue;
      const to = table.to[i]!;
      const target = b[to]!;
      if (target !== EMPTY && (target >> 3) === color) continue;
      if (capturesOnly && target === EMPTY) continue;
      out.push(from | (to << 7) | (target << 14));
    }
  }

  /** Legal moves only — the list the UI and the search both consume. */
  generateLegalMoves(color: Color = this.side): Move[] {
    const legal: Move[] = [];
    const pseudo = this.generateMoves(color);
    for (let i = 0; i < pseudo.length; i++) {
      const m = pseudo[i]!;
      if (this.tryMove(m)) {
        this.unmakeMove();
        legal.push(m);
      }
    }
    return legal;
  }

  /** Legal destinations for one square — what the XR board highlights. */
  legalTargets(from: number): number[] {
    const piece = this.board[from]!;
    if (piece === EMPTY) return [];
    const color = colorOf(piece);
    const targets: number[] = [];
    for (const m of this.generateMoves(color)) {
      if (moveFrom(m) !== from) continue;
      if (this.tryMove(m)) {
        this.unmakeMove();
        targets.push(moveTo(m));
      }
    }
    return targets;
  }

  // ------------------------------------------------------------- attacks ---

  /**
   * Is `square` attacked by any piece of `by`? Includes the 飛將 rule: an
   * enemy general with a clear file behaves like a chariot on that file, which
   * is what makes exposing the two generals to each other illegal.
   */
  isAttacked(square: number, by: Color): boolean {
    const b = this.board;
    const base = square << 2;

    for (let dir = 0; dir < 4; dir++) {
      const end = RAY_START[base + dir + 1]!;
      let seen = 0;
      for (let i = RAY_START[base + dir]!; i < end; i++) {
        const p = b[RAY_TO[i]!]!;
        if (p === EMPTY) continue;
        seen++;
        if (seen === 1) {
          if ((p >> 3) === by) {
            const t = p & 7;
            if (t === CHARIOT) return true;
            // Directions 0 and 1 run along the file — 飛將.
            if (t === GENERAL && dir < 2) return true;
          }
        } else {
          if ((p >> 3) === by && (p & 7) === CANNON) return true;
          break;
        }
      }
    }

    if (this.attackedByStep(HORSE_ATTACKS, square, by, HORSE)) return true;
    if (this.attackedByStep(SOLDIER_ATTACKS[by], square, by, SOLDIER)) return true;
    if (this.attackedByStep(ADVISOR_ATTACKS[by], square, by, ADVISOR)) return true;
    if (this.attackedByStep(ELEPHANT_ATTACKS[by], square, by, ELEPHANT)) return true;
    if (this.attackedByStep(GENERAL_ATTACKS[by], square, by, GENERAL)) return true;
    return false;
  }

  private attackedByStep(table: StepTable, square: number, by: Color, type: number): boolean {
    const b = this.board;
    const want = type | (by << 3);
    const end = table.start[square + 1]!;
    for (let i = table.start[square]!; i < end; i++) {
      if (b[table.to[i]!] !== want) continue;
      const block = table.block[i]!;
      if (block < 0 || b[block] === EMPTY) return true;
    }
    return false;
  }

  inCheck(color: Color = this.side): boolean {
    const g = this.generalSq[color];
    if (g < 0) return false;
    return this.isAttacked(g, (color ^ 1) as Color);
  }

  // ------------------------------------------------------------- make/unmake

  /** Apply a move with no legality check. Use {@link tryMove} unless you know. */
  makeMove(move: Move): void {
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    const captured = (move >> 14) & 0xf;
    const piece = this.board[from]!;

    this.growStack(this.ply);
    const ply = this.ply++;
    this.stackMove[ply] = move;
    this.stackHashLo[ply] = this.hashLo;
    this.stackHashHi[ply] = this.hashHi;
    this.stackClock[ply] = this.halfmoveClock;
    this.stackCheck[ply] = 0;

    let lo = this.hashLo;
    let hi = this.hashHi;
    const zFrom = piece * BOARD_SIZE + from;
    lo ^= ZOB_LO[zFrom]!; hi ^= ZOB_HI[zFrom]!;
    if (captured !== EMPTY) {
      const zCap = captured * BOARD_SIZE + to;
      lo ^= ZOB_LO[zCap]!; hi ^= ZOB_HI[zCap]!;
      if ((captured & 7) === GENERAL) this.generalSq[(captured >> 3) as Color] = -1;
    }
    const zTo = piece * BOARD_SIZE + to;
    lo ^= ZOB_LO[zTo]!; hi ^= ZOB_HI[zTo]!;
    lo ^= ZOB_SIDE_LO; hi ^= ZOB_SIDE_HI;

    this.board[from] = EMPTY;
    this.board[to] = piece;
    if ((piece & 7) === GENERAL) this.generalSq[(piece >> 3) as Color] = to;

    this.hashLo = lo | 0;
    this.hashHi = hi | 0;
    this.halfmoveClock = captured === EMPTY ? this.halfmoveClock + 1 : 0;
    if (this.side === BLACK) this.fullmoveNumber++;
    this.side = (this.side ^ 1) as Color;
  }

  unmakeMove(): void {
    if (this.ply === 0) return;
    const ply = --this.ply;
    const move = this.stackMove[ply]!;
    const from = move & 0x7f;
    const to = (move >> 7) & 0x7f;
    const captured = (move >> 14) & 0xf;
    const piece = this.board[to]!;

    this.board[from] = piece;
    this.board[to] = captured;
    if ((piece & 7) === GENERAL) this.generalSq[(piece >> 3) as Color] = from;
    if (captured !== EMPTY && (captured & 7) === GENERAL) {
      this.generalSq[(captured >> 3) as Color] = to;
    }

    this.hashLo = this.stackHashLo[ply]!;
    this.hashHi = this.stackHashHi[ply]!;
    this.halfmoveClock = this.stackClock[ply]!;
    this.side = (this.side ^ 1) as Color;
    if (this.side === BLACK) this.fullmoveNumber--;
  }

  /**
   * Make the move only if it leaves our own general safe. Returns true with the
   * move applied (the caller must unmake it), or false with the position
   * untouched. This is the search's inner loop: no allocation, no extra
   * attack scans beyond the one legality check.
   */
  tryMove(move: Move): boolean {
    const mover = this.side;
    this.makeMove(move);
    const general = this.generalSq[mover];
    if (general < 0 || this.isAttacked(general, (mover ^ 1) as Color)) {
      this.unmakeMove();
      return false;
    }
    return true;
  }

  /**
   * Commit a move to the game record. Unlike {@link tryMove} this also records
   * whether the move gave check, which the repetition rules need.
   */
  applyMove(move: Move): boolean {
    const from = moveFrom(move);
    const to = moveTo(move);
    const piece = this.board[from]!;
    if (piece === EMPTY || colorOf(piece) !== this.side) return false;
    // Re-encode so a client cannot lie about the captured piece.
    const canonical = encodeMove(from, to, this.board[to]!);
    if (!this.generateMoves(this.side).includes(canonical)) return false;
    if (!this.tryMove(canonical)) return false;
    this.stackCheck[this.ply - 1] = this.inCheck(this.side) ? 1 : 0;
    return true;
  }

  /** Take back the last move. Used by 悔棋. */
  undo(): Move {
    if (this.ply === 0) return NO_MOVE;
    const move = this.stackMove[this.ply - 1]!;
    this.unmakeMove();
    return move;
  }

  /** Look up a coordinate pair among the legal moves. */
  findMove(from: number, to: number): Move {
    const pseudo = this.generateMoves(this.side);
    for (const m of pseudo) {
      if (moveFrom(m) === from && moveTo(m) === to) {
        if (this.tryMove(m)) { this.unmakeMove(); return m; }
        return NO_MOVE;
      }
    }
    return NO_MOVE;
  }

  // ----------------------------------------------------------- game state ---

  /**
   * How many times the current position has occurred in this game. Only
   * positions since the last capture can repeat, and only every second ply has
   * the same side to move, so the scan steps backwards two at a time.
   */
  repetitionCount(): number {
    if (this.halfmoveClock < 4) return 1;
    const lo = this.hashLo;
    const hi = this.hashHi;
    const stop = Math.max(0, this.ply - this.halfmoveClock);
    let count = 1;
    for (let i = this.ply - 2; i >= stop; i -= 2) {
      if (this.stackHashLo[i] === lo && this.stackHashHi[i] === hi) count++;
    }
    return count;
  }

  private hasAttackingMaterial(color: Color): boolean {
    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      const p = this.board[sq]!;
      if (p === EMPTY || colorOf(p) !== color) continue;
      const t = typeOf(p);
      if (t === CHARIOT || t === CANNON || t === HORSE || t === SOLDIER) return true;
    }
    return false;
  }

  /**
   * Who, if anyone, has won. Note two Xiangqi-specific rules:
   *  - Having no legal move is a **loss**, not a draw (困毙).
   *  - Repeating a position by giving check every time (长将) loses for the
   *    checking side rather than drawing.
   */
  status(): GameOver | null {
    if (this.generalSq[RED] < 0) return { result: 'black', reason: 'checkmate' };
    if (this.generalSq[BLACK] < 0) return { result: 'red', reason: 'checkmate' };

    if (this.generateLegalMoves(this.side).length === 0) {
      return {
        result: this.side === RED ? 'black' : 'red',
        reason: this.inCheck(this.side) ? 'checkmate' : 'stalemate',
      };
    }

    if (this.repetitionCount() >= 3) {
      const perpetual = this.perpetualChecker();
      if (perpetual !== null) {
        return { result: perpetual === RED ? 'black' : 'red', reason: 'repetition' };
      }
      return { result: 'draw', reason: 'repetition' };
    }

    if (this.halfmoveClock >= NO_CAPTURE_PLY_LIMIT) {
      return { result: 'draw', reason: 'no-capture-limit' };
    }

    if (!this.hasAttackingMaterial(RED) && !this.hasAttackingMaterial(BLACK)) {
      return { result: 'draw', reason: 'insufficient-material' };
    }

    return null;
  }

  /**
   * 长将判负: within the repeated window, if exactly one side checked on every
   * one of its moves, that side is the aggressor and loses instead of drawing.
   */
  private perpetualChecker(): Color | null {
    let start = -1;
    for (let i = this.ply - 1; i >= 0; i--) {
      if (this.stackHashLo[i] === this.hashLo && this.stackHashHi[i] === this.hashHi) {
        start = i;
        break;
      }
    }
    if (start < 0) return null;

    const allChecks: [boolean, boolean] = [true, true];
    const moved: [boolean, boolean] = [false, false];
    for (let i = start; i < this.ply; i++) {
      // Moves alternate, so counting back from the current side identifies
      // whoever played ply i.
      const mover: Color = (this.ply - 1 - i) % 2 === 0
        ? other(this.side)
        : this.side;
      moved[mover] = true;
      if (this.stackCheck[i] !== 1) allChecks[mover] = false;
    }
    const redPerpetual = moved[RED] && allChecks[RED];
    const blackPerpetual = moved[BLACK] && allChecks[BLACK];
    if (redPerpetual && !blackPerpetual) return RED;
    if (blackPerpetual && !redPerpetual) return BLACK;
    return null;
  }

  /** Material tally for the capture tray in the XR scene. */
  capturedPieces(): Piece[] {
    const expected = new Map<Piece, number>();
    const start = Position.fromFen(START_FEN);
    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      const p = start.board[sq]!;
      if (p !== EMPTY) expected.set(p, (expected.get(p) ?? 0) + 1);
    }
    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      const p = this.board[sq]!;
      if (p !== EMPTY) expected.set(p, (expected.get(p) ?? 0) - 1);
    }
    const out: Piece[] = [];
    for (const [piece, count] of expected) for (let i = 0; i < count; i++) out.push(piece);
    return out;
  }
}

const FEN_TO_PIECE: Record<string, Piece> = {
  K: makePiece(GENERAL, RED), A: makePiece(ADVISOR, RED), B: makePiece(ELEPHANT, RED),
  E: makePiece(ELEPHANT, RED), N: makePiece(HORSE, RED), H: makePiece(HORSE, RED),
  R: makePiece(CHARIOT, RED), C: makePiece(CANNON, RED), P: makePiece(SOLDIER, RED),
  k: makePiece(GENERAL, BLACK), a: makePiece(ADVISOR, BLACK), b: makePiece(ELEPHANT, BLACK),
  e: makePiece(ELEPHANT, BLACK), n: makePiece(HORSE, BLACK), h: makePiece(HORSE, BLACK),
  r: makePiece(CHARIOT, BLACK), c: makePiece(CANNON, BLACK), p: makePiece(SOLDIER, BLACK),
};

const PIECE_TO_FEN: Record<number, string> = {
  [makePiece(GENERAL, RED)]: 'K', [makePiece(ADVISOR, RED)]: 'A', [makePiece(ELEPHANT, RED)]: 'B',
  [makePiece(HORSE, RED)]: 'N', [makePiece(CHARIOT, RED)]: 'R', [makePiece(CANNON, RED)]: 'C',
  [makePiece(SOLDIER, RED)]: 'P',
  [makePiece(GENERAL, BLACK)]: 'k', [makePiece(ADVISOR, BLACK)]: 'a',
  [makePiece(ELEPHANT, BLACK)]: 'b', [makePiece(HORSE, BLACK)]: 'n',
  [makePiece(CHARIOT, BLACK)]: 'r', [makePiece(CANNON, BLACK)]: 'c',
  [makePiece(SOLDIER, BLACK)]: 'p',
};
