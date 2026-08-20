import { describe, expect, it } from 'vitest';
import {
  BLACK, Position, buildFen, iccsToMove, moveToIccs, type Placement,
} from '@ccx/shared';
import {
  LEVELS, MATE_THRESHOLD, Searcher, TT_EXACT, TranspositionTable, chooseMove, evaluate,
  levelSpec, mateDistance,
} from '../src/index.js';

const at = (ch: string, row: number, col: number): Placement => [ch, row, col];

const run = (fen: string, depth: number, timeMs = 2000) => {
  const pos = Position.fromFen(fen);
  const searcher = new Searcher({ tt: new TranspositionTable(8) });
  const result = searcher.search(pos, { depth, timeMs });
  return { result, iccs: result.bestMove ? moveToIccs(result.bestMove) : '' };
};

describe('evaluation', () => {
  it('is symmetric about the start position', () => {
    const red = Position.fromFen();
    const black = Position.fromFen(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b - - 0 1',
    );
    // Both sides see the same small tempo bonus and nothing else.
    expect(evaluate(red)).toBe(evaluate(black));
  });

  it('counts a free chariot as a large advantage', () => {
    const even = Position.fromFen(buildFen([at('K', 9, 4), at('k', 0, 3), at('R', 5, 0)]));
    const score = evaluate(even);
    expect(score).toBeGreaterThan(800);
  });

  it('punishes a general stripped of its advisors against heavy pieces', () => {
    const withAdvisors = evaluate(Position.fromFen(
      buildFen([at('K', 9, 4), at('A', 9, 3), at('A', 9, 5), at('k', 0, 3), at('r', 5, 0), at('r', 5, 8)]),
    ));
    const without = evaluate(Position.fromFen(
      buildFen([at('K', 9, 4), at('k', 0, 3), at('r', 5, 0), at('r', 5, 8)]),
    ));
    expect(without).toBeLessThan(withAdvisors);
  });

  it('rewards a cannon staring down an open file at the general', () => {
    const hollow = evaluate(Position.fromFen(
      buildFen([at('K', 9, 3), at('C', 5, 4), at('k', 0, 4)]),
    ));
    const offFile = evaluate(Position.fromFen(
      buildFen([at('K', 9, 3), at('C', 5, 1), at('k', 0, 4)]),
    ));
    expect(hollow).toBeGreaterThan(offFile);
  });
});

describe('search', () => {
  it('finds mate in one', () => {
    const { result, iccs } = run(
      buildFen([at('K', 9, 4), at('R', 5, 0), at('k', 0, 4), at('b', 1, 4)]), 3,
    );
    expect(iccs).toBe('a4a9');
    expect(result.score).toBeGreaterThan(MATE_THRESHOLD);
    expect(mateDistance(result.score)).toBe(1);
  });

  it('takes free material', () => {
    // Black chariot sits undefended on the red chariot's file.
    const { iccs } = run(
      buildFen([at('K', 9, 3), at('k', 0, 5), at('R', 9, 0), at('r', 4, 0), at('p', 3, 8)]), 4,
    );
    expect(iccs).toBe('a0a5');
  });

  it('does not hang its own chariot for nothing', () => {
    // Moving to a5 would be met by ...rxa5. Depth 4 should see it.
    const { iccs } = run(
      buildFen([
        at('K', 9, 3), at('k', 0, 5), at('R', 9, 0), at('r', 4, 1), at('r', 0, 0),
      ]), 5,
    );
    expect(iccs).not.toBe('a0a5');
  });

  it('answers a check with the capture that also wins the piece', () => {
    // Black's chariot checks down the middle file; Red's chariot can take it.
    const pos = Position.fromFen(buildFen([
      at('K', 9, 4), at('A', 9, 3), at('A', 9, 5), at('k', 0, 4), at('r', 5, 4), at('R', 5, 8),
    ]));
    expect(pos.inCheck()).toBe(true);
    const searcher = new Searcher({ tt: new TranspositionTable(8) });
    const result = searcher.search(pos, { depth: 5, timeMs: 3000 });
    expect(moveToIccs(result.bestMove)).toBe('i4e4');
    expect(result.score).toBeGreaterThan(500);
  });

  it('reports a losing score when it is being mated', () => {
    const pos = Position.fromFen(
      buildFen([at('k', 0, 4), at('b', 1, 4), at('K', 9, 4), at('R', 0, 0)], BLACK),
    );
    const searcher = new Searcher({ tt: new TranspositionTable(4) });
    const result = searcher.search(pos, { depth: 3, timeMs: 500 });
    expect(result.bestMove).toBe(0);
    expect(result.score).toBeLessThan(-MATE_THRESHOLD);
  });

  it('deepens monotonically and leaves the position untouched', () => {
    const fen = Position.fromFen().toFen();
    const pos = Position.fromFen(fen);
    const searcher = new Searcher({ tt: new TranspositionTable(16) });
    const depths: number[] = [];
    searcher.search(pos, { depth: 5, timeMs: 4000 });
    expect(pos.toFen()).toBe(fen);
    expect(pos.plies).toBe(0);
    expect(depths.length).toBe(0);
  });

  it('respects a node limit', () => {
    const pos = Position.fromFen();
    const searcher = new Searcher({ tt: new TranspositionTable(8) });
    const result = searcher.search(pos, { depth: 30, timeMs: 60_000, nodes: 20_000 });
    expect(result.nodes).toBeLessThan(80_000);
    expect(result.bestMove).not.toBe(0);
  });

  it('respects a time budget', () => {
    const pos = Position.fromFen();
    const searcher = new Searcher({ tt: new TranspositionTable(8) });
    const started = Date.now();
    searcher.search(pos, { depth: 30, timeMs: 400 });
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('plays a sensible opening move', () => {
    const { iccs } = run(Position.fromFen().toFen(), 6, 4000);
    // Any of the standard first moves is fine; a wing soldier push is not.
    const pos = Position.fromFen();
    expect(iccsToMove(pos, iccs)).not.toBe(0);
    expect(['a3a4', 'i3i4']).not.toContain(iccs);
  });

  it('searches deeper with a shared table across repeated calls', () => {
    const tt = new TranspositionTable(16);
    const pos = Position.fromFen();
    const first = new Searcher({ tt }).search(pos, { depth: 6, timeMs: 3000 });
    const second = new Searcher({ tt }).search(pos, { depth: 6, timeMs: 3000 });
    expect(second.nodes).toBeLessThanOrEqual(first.nodes * 1.2);
  });
});

describe('transposition table', () => {
  it('round-trips an entry', () => {
    const tt = new TranspositionTable(1);
    tt.store(0x1234, 0x5678, 42, -900, 7, TT_EXACT);
    const probe = { hit: false, move: 0, score: 0, depth: 0, flag: 0 };
    tt.probe(0x1234, 0x5678, probe);
    expect(probe.hit).toBe(true);
    expect(probe.move).toBe(42);
    expect(probe.score).toBe(-900);
    expect(probe.depth).toBe(7);
    expect(probe.flag).toBe(TT_EXACT);
  });

  it('misses on a different high word', () => {
    const tt = new TranspositionTable(1);
    tt.store(0x1234, 0x5678, 42, -900, 7, TT_EXACT);
    const probe = { hit: false, move: 0, score: 0, depth: 0, flag: 0 };
    tt.probe(0x1234, 0x9999, probe);
    expect(probe.hit).toBe(false);
  });

  it('sizes itself to a power of two', () => {
    expect(TranspositionTable.bytesFor(16) % 12).toBe(0);
    expect(Math.log2(TranspositionTable.bytesFor(16) / 12) % 1).toBe(0);
  });
});

describe('difficulty levels', () => {
  it('increase in strength monotonically', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i]!.depth).toBeGreaterThanOrEqual(LEVELS[i - 1]!.depth);
      expect(LEVELS[i]!.timeMs).toBeGreaterThanOrEqual(LEVELS[i - 1]!.timeMs);
      expect(LEVELS[i]!.evalNoise).toBeLessThanOrEqual(LEVELS[i - 1]!.evalNoise);
      expect(LEVELS[i]!.blunderChance).toBeLessThanOrEqual(LEVELS[i - 1]!.blunderChance);
      expect(LEVELS[i]!.rating).toBeGreaterThan(LEVELS[i - 1]!.rating);
    }
  });

  it('clamps out-of-range levels', () => {
    expect(levelSpec(0).level).toBe(1);
    expect(levelSpec(99).level).toBe(8);
    expect(levelSpec(4.4).level).toBe(4);
  });

  it('leaves cores free for the render loop', () => {
    for (const spec of LEVELS) expect(spec.threads).toBeLessThanOrEqual(3);
  });
});

describe('move choice', () => {
  const rootScores = (pos: Position) =>
    pos.generateLegalMoves().map((move, i) => ({ move, score: 100 - i * 50 }));

  it('plays the best move at full strength', () => {
    const pos = Position.fromFen();
    const scores = rootScores(pos);
    const choice = chooseMove(pos, scores, levelSpec(8), () => 0.5);
    expect(choice.move).toBe(scores[0]!.move);
    expect(choice.deviated).toBe(false);
  });

  it('deviates when the level says to blunder', () => {
    const pos = Position.fromFen();
    const spec = { ...levelSpec(1), blunderChance: 1 };
    let calls = 0;
    // A deterministic "random" that always returns a low value shuffles the
    // list, so the chosen move is not the best one.
    const choice = chooseMove(pos, rootScores(pos), spec, () => (calls++ % 7) / 7);
    expect(choice.move).not.toBe(0);
  });

  it('never returns an illegal move', () => {
    const pos = Position.fromFen();
    for (let level = 1; level <= 8; level++) {
      for (let trial = 0; trial < 20; trial++) {
        const choice = chooseMove(pos, rootScores(pos), levelSpec(level));
        expect(pos.tryMove(choice.move)).toBe(true);
        pos.unmakeMove();
      }
    }
  });
});

describe('self play', () => {
  it('produces a legal game and terminates', () => {
    const pos = Position.fromFen();
    const tt = new TranspositionTable(8);
    const searcher = new Searcher({ tt });
    let plies = 0;
    while (plies < 40 && pos.status() === null) {
      const result = searcher.search(pos, { depth: 3, timeMs: 60 });
      expect(result.bestMove, `no move at ply ${plies}`).not.toBe(0);
      const applied = pos.applyMove(result.bestMove);
      expect(applied, `illegal move at ply ${plies}`).toBe(true);
      plies++;
    }
    expect(plies).toBeGreaterThan(10);
    // The position must still be self-consistent after all that.
    expect(Position.fromFen(pos.toFen()).toFen()).toBe(pos.toFen());
  }, 30_000);
});
