/**
 * Owns the one live `Position` and turns it into immutable snapshots the UI and
 * the 3D scene render from. Nothing outside this file mutates a position, which
 * is what keeps React and Three from ever disagreeing about the board.
 *
 * The same controller drives all three modes:
 *  - `ai`       the search runs in workers on this device; 悔棋 is instant
 *  - `pvp`      the server is authoritative; 悔棋 needs the opponent's consent
 *  - `tutorial` a scratch position with no opponent at all
 */
import {
  BLACK, EMPTY, Position, RED, START_FEN, colorOf, describeMove, iccsToMove, moveFrom, moveTo,
  moveToIccs, squareToCoord,
  type Color, type GameState, type Move, type MoveRecord, type Piece,
} from '@ccx/shared';
import { levelSpec, type Engine } from '@ccx/ai';

export type Mode = 'idle' | 'ai' | 'pvp' | 'tutorial';

export interface Snapshot {
  mode: Mode;
  fen: string;
  /** Piece code per square; a copy, safe to hold. */
  squares: Int8Array;
  turn: Color;
  /** The side this device plays, or null when spectating or in the tutorial. */
  myColor: Color | null;
  selected: number | null;
  targets: number[];
  lastMove: { from: number; to: number } | null;
  inCheck: boolean;
  /** The general under attack, for the warning ring. */
  checkSquare: number | null;
  moves: MoveRecord[];
  captured: Piece[];
  over: { result: 'red' | 'black' | 'draw'; reason: string } | null;
  /** True when this device may move a piece right now. */
  canMove: boolean;
  canUndo: boolean;
  thinking: boolean;
  /** Engine readout, shown in the HUD when playing the AI. */
  evaluation: { score: number; depth: number; mateIn: number | null } | null;
  aiLevel: number;
  /** Squares to highlight in the tutorial as the thing doing the blocking. */
  obstacles: number[];
  hint: { from: number; to: number } | null;
}

export interface ControllerCallbacks {
  onSnapshot(snapshot: Snapshot): void;
  /** A move was made locally and should be sent to the server (pvp only). */
  onLocalMove(iccs: string): void;
  /** A game against the AI finished; report it for rating. */
  onAiGameOver(result: {
    result: 'red' | 'black' | 'draw'; level: number; playerColor: 'red' | 'black';
    moves: string[]; undos: number;
  }): void;
  onSound(sound: 'move' | 'capture' | 'check' | 'win' | 'lose' | 'illegal'): void;
}

export class GameController {
  private position = Position.fromFen(START_FEN);
  private mode: Mode = 'idle';
  private myColor: Color | null = null;
  private selected: number | null = null;
  private lastMove: { from: number; to: number } | null = null;
  private moves: MoveRecord[] = [];
  private over: Snapshot['over'] = null;
  private thinking = false;
  private evaluation: Snapshot['evaluation'] = null;
  private aiLevel = 4;
  private obstacles: number[] = [];
  private hint: Snapshot['hint'] = null;
  private undosUsed = 0;
  /** Rising counter so a stale engine reply from a cancelled game is ignored. */
  private searchEpoch = 0;

  constructor(
    private readonly callbacks: ControllerCallbacks,
    private engine: Engine | null = null,
  ) {}

  attachEngine(engine: Engine): void {
    this.engine = engine;
  }

  // -------------------------------------------------------------- snapshots --

  snapshot(): Snapshot {
    const squares = new Int8Array(90);
    squares.set(this.position.board);
    const inCheck = this.position.inCheck();
    return {
      mode: this.mode,
      fen: this.position.toFen(),
      squares,
      turn: this.position.side,
      myColor: this.myColor,
      selected: this.selected,
      targets: this.selected === null ? [] : this.position.legalTargets(this.selected),
      lastMove: this.lastMove,
      inCheck,
      checkSquare: inCheck ? this.position.generalSq[this.position.side] : null,
      moves: this.moves,
      captured: this.position.capturedPieces(),
      over: this.over,
      canMove: this.canMove(),
      canUndo: this.canUndo(),
      thinking: this.thinking,
      evaluation: this.evaluation,
      aiLevel: this.aiLevel,
      obstacles: this.obstacles,
      hint: this.hint,
    };
  }

  private emit(): void {
    this.callbacks.onSnapshot(this.snapshot());
  }

  private canMove(): boolean {
    if (this.over) return false;
    if (this.mode === 'tutorial') return true;
    if (this.mode === 'ai') return !this.thinking && this.position.side === this.myColor;
    if (this.mode === 'pvp') return this.position.side === this.myColor;
    return false;
  }

  private canUndo(): boolean {
    if (this.mode === 'ai') return this.position.plies > 0;
    if (this.mode === 'pvp') return !this.over && this.position.plies > 0 && this.myColor !== null;
    if (this.mode === 'tutorial') return this.position.plies > 0;
    return false;
  }

  // ------------------------------------------------------------ interaction --

  /** Tap a square: select a piece, deselect it, or play a move to it. */
  tap(square: number): void {
    if (this.over && this.mode !== 'tutorial') return;
    const piece = this.position.pieceAt(square);

    if (this.selected !== null) {
      if (square === this.selected) {
        this.selected = null;
        this.emit();
        return;
      }
      const move = this.position.findMove(this.selected, square);
      if (move !== 0) {
        this.play(move);
        return;
      }
      // Not a legal target: treat it as picking up a different piece instead.
      if (piece !== EMPTY && this.canSelect(square)) {
        this.selected = square;
        this.emit();
        return;
      }
      this.callbacks.onSound('illegal');
      this.selected = null;
      this.emit();
      return;
    }

    if (piece !== EMPTY && this.canSelect(square)) {
      this.selected = square;
      this.hint = null;
      this.emit();
    }
  }

  private canSelect(square: number): boolean {
    const piece = this.position.pieceAt(square);
    if (piece === EMPTY) return false;
    if (this.mode === 'tutorial') return true;
    if (!this.canMove()) return false;
    return colorOf(piece) === this.position.side && this.position.side === this.myColor;
  }

  /** Drag-and-drop entry point: returns true if the move was legal. */
  drop(from: number, to: number): boolean {
    const move = this.position.findMove(from, to);
    if (move === 0) {
      this.callbacks.onSound('illegal');
      this.selected = null;
      this.emit();
      return false;
    }
    this.selected = from;
    this.play(move);
    return true;
  }

  private play(move: Move, fromNetwork = false): void {
    const captured = this.position.pieceAt(moveTo(move)) !== EMPTY;
    const text = describeMove(this.position, move);
    if (!this.position.applyMove(move)) {
      this.callbacks.onSound('illegal');
      return;
    }
    this.moves = [...this.moves, { ...text, ms: 0 }];
    this.lastMove = { from: moveFrom(move), to: moveTo(move) };
    this.selected = null;
    this.hint = null;

    const check = this.position.inCheck();
    this.callbacks.onSound(check ? 'check' : captured ? 'capture' : 'move');

    if (this.mode === 'pvp' && !fromNetwork) this.callbacks.onLocalMove(text.iccs);

    const status = this.position.status();
    if (status) {
      this.finish(status.result, status.reason);
      return;
    }
    this.emit();
    if (this.mode === 'ai' && this.position.side !== this.myColor) void this.askEngine();
  }

  private finish(result: 'red' | 'black' | 'draw', reason: string): void {
    this.over = { result, reason };
    this.thinking = false;
    const won = this.myColor !== null
      && result !== 'draw'
      && (result === 'red' ? RED : BLACK) === this.myColor;
    this.callbacks.onSound(result === 'draw' ? 'move' : won ? 'win' : 'lose');
    this.emit();

    if (this.mode === 'ai' && this.myColor !== null) {
      this.callbacks.onAiGameOver({
        result,
        level: this.aiLevel,
        playerColor: this.myColor === RED ? 'red' : 'black',
        moves: this.moves.map((m) => m.iccs),
        undos: this.undosUsed,
      });
    }
  }

  // -------------------------------------------------------------- AI driving --

  private async askEngine(): Promise<void> {
    if (!this.engine || this.over) return;
    const epoch = ++this.searchEpoch;
    this.thinking = true;
    this.emit();

    try {
      const outcome = await this.engine.bestMove({
        startFen: START_FEN,
        moves: this.moves.map((m) => m.iccs),
        level: this.aiLevel,
      });
      // A take-back or a new game while the search ran invalidates this answer.
      if (epoch !== this.searchEpoch || this.over) return;
      this.thinking = false;
      this.evaluation = {
        // Scores come from the mover's point of view; show them from the player's.
        score: this.myColor === this.position.side ? outcome.score : -outcome.score,
        depth: outcome.depth,
        mateIn: outcome.mateIn,
      };
      const move = iccsToMove(this.position, outcome.iccs);
      if (move === 0) {
        // Should be impossible: the worker runs the same rules engine. Fall back
        // to any legal move rather than stalling the game.
        const legal = this.position.generateLegalMoves();
        if (legal.length === 0) return;
        this.play(legal[Math.floor(Math.random() * legal.length)]!);
        return;
      }
      this.play(move);
    } catch {
      this.thinking = false;
      this.emit();
    }
  }

  /** Ask the engine for a strong move without playing it. */
  async requestHint(): Promise<void> {
    if (!this.engine || !this.canMove()) return;
    this.thinking = true;
    this.emit();
    try {
      const outcome = await this.engine.bestMove({
        startFen: START_FEN,
        moves: this.moves.map((m) => m.iccs),
        level: 6,
        limits: { timeMs: 1200 },
      });
      const move = iccsToMove(this.position, outcome.bestIccs || outcome.iccs);
      this.hint = move === 0 ? null : { from: moveFrom(move), to: moveTo(move) };
    } finally {
      this.thinking = false;
      this.emit();
    }
  }

  // ------------------------------------------------------------------ modes --

  startAi(level: number, playerColor: Color): void {
    this.searchEpoch++;
    this.engine?.stop();
    this.engine?.newGame();
    this.position = Position.fromFen(START_FEN);
    this.mode = 'ai';
    this.myColor = playerColor;
    this.aiLevel = Math.max(1, Math.min(8, Math.round(level)));
    this.reset();
    this.emit();
    if (playerColor !== RED) void this.askEngine();
  }

  startPvp(myColor: Color | null): void {
    this.searchEpoch++;
    this.position = Position.fromFen(START_FEN);
    this.mode = 'pvp';
    this.myColor = myColor;
    this.reset();
    this.emit();
  }

  startTutorial(fen: string, focus: number | null, obstacles: number[] = []): void {
    this.searchEpoch++;
    this.position = Position.fromFen(fen);
    this.mode = 'tutorial';
    this.myColor = null;
    this.reset();
    this.obstacles = obstacles;
    this.selected = focus;
    this.emit();
  }

  leave(): void {
    this.searchEpoch++;
    this.engine?.stop();
    this.mode = 'idle';
    this.myColor = null;
    this.reset();
    this.emit();
  }

  private reset(): void {
    this.selected = null;
    this.lastMove = null;
    this.moves = [];
    this.over = null;
    this.thinking = false;
    this.evaluation = null;
    this.obstacles = [];
    this.hint = null;
    this.undosUsed = 0;
  }

  // ------------------------------------------------------------- 悔棋 undo --

  /**
   * Local take-back. Against the AI this is unconditional and takes back far
   * enough that it is the player's turn again; in the tutorial it just steps
   * back one move. PvP take-backs never come through here — they arrive as a
   * fresh authoritative state from the server once the opponent agrees.
   */
  undoLocal(): void {
    if (this.mode === 'pvp' || this.position.plies === 0) return;
    this.searchEpoch++; // abandon any search in flight
    this.engine?.stop();
    this.thinking = false;

    if (this.mode === 'tutorial') {
      this.position.undo();
      this.moves = this.moves.slice(0, -1);
    } else {
      // Pop at least one ply, and keep going until it is our move again.
      let popped = 0;
      while (this.position.plies > 0 && (popped === 0 || this.position.side !== this.myColor)) {
        this.position.undo();
        this.moves = this.moves.slice(0, -1);
        popped++;
        if (popped >= 2) break;
      }
      this.undosUsed++;
    }

    this.over = null;
    this.selected = null;
    this.hint = null;
    this.evaluation = null;
    const last = this.position.plies > 0 ? this.position.moveAt(this.position.plies - 1) : 0;
    this.lastMove = last === 0 ? null : { from: moveFrom(last), to: moveTo(last) };
    this.emit();
  }

  resignLocal(): void {
    if (this.mode !== 'ai' || this.myColor === null || this.over) return;
    this.finish(this.myColor === RED ? 'black' : 'red', 'resignation');
  }

  // --------------------------------------------------- server reconciliation --

  /**
   * Adopt the server's version of a PvP game. The move list is replayed from the
   * start so repetition history is exact, then checked against the server's FEN;
   * a mismatch means one side has a bug, and the server always wins.
   */
  applyServerState(state: GameState, myColor: Color | null): void {
    this.mode = 'pvp';
    this.myColor = myColor;

    const rebuilt = Position.fromFen(START_FEN);
    for (const record of state.moves) {
      const move = iccsToMove(rebuilt, record.iccs);
      if (move === 0) {
        console.error('server sent a move this client considers illegal', record.iccs);
        break;
      }
      rebuilt.applyMove(move);
    }
    if (rebuilt.toFen() !== state.fen) {
      console.warn('board desync; trusting the server', { local: rebuilt.toFen(), server: state.fen });
      rebuilt.setFen(state.fen);
    }

    const previousPlies = this.position.plies;
    this.position = rebuilt;
    this.moves = state.moves;
    this.over = state.over;
    this.selected = null;
    this.hint = null;

    const lastPly = rebuilt.plies > 0 ? rebuilt.moveAt(rebuilt.plies - 1) : 0;
    this.lastMove = lastPly === 0 ? null : { from: moveFrom(lastPly), to: moveTo(lastPly) };

    // Only make noise for moves we did not just make ourselves.
    if (state.moves.length > previousPlies && state.moves.length > 0) {
      this.callbacks.onSound(state.inCheck ? 'check' : 'move');
    }
    this.emit();
  }

  currentMoves(): string[] {
    return this.moves.map((m) => m.iccs);
  }

  /** Legal destinations for a square, for the 3D board's drag preview. */
  targetsFor(square: number): number[] {
    return this.position.legalTargets(square);
  }

  describe(square: number): string {
    return squareToCoord(square);
  }

  levelLabel(lang: 'zh' | 'en'): string {
    return levelSpec(this.aiLevel).label[lang];
  }

  /** Check whether a tutorial challenge has been solved. */
  lastMoveIccs(): string | null {
    if (this.position.plies === 0) return null;
    return moveToIccs(this.position.moveAt(this.position.plies - 1));
  }
}
