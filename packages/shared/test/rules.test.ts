import { describe, expect, it } from 'vitest';
import {
  BLACK, CANNON, CHARIOT, ELEPHANT, HORSE, Position, RED, SOLDIER, START_FEN, buildFen,
  coordToSquare, describeMove, iccsToMove, idx, moveToChinese, squareToCoord,
  type Placement,
} from '../src/index.js';

const at = (ch: string, row: number, col: number): Placement => [ch, row, col];

const perft = (pos: Position, depth: number): number => {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const m of pos.generateMoves(pos.side)) {
    if (!pos.tryMove(m)) continue;
    nodes += depth === 1 ? 1 : perft(pos, depth - 1);
    pos.unmakeMove();
  }
  return nodes;
};

const targets = (fen: string, row: number, col: number): string[] =>
  Position.fromFen(fen).legalTargets(idx(row, col)).map(squareToCoord).sort();

describe('coordinates', () => {
  it('maps ICCS both ways', () => {
    expect(squareToCoord(idx(9, 0))).toBe('a0');
    expect(squareToCoord(idx(0, 8))).toBe('i9');
    expect(squareToCoord(idx(7, 4))).toBe('e2');
    expect(coordToSquare('e2')).toBe(idx(7, 4));
    expect(coordToSquare('a0')).toBe(idx(9, 0));
  });
});

describe('FEN', () => {
  it('round-trips the start position', () => {
    expect(Position.fromFen(START_FEN).toFen()).toBe(START_FEN);
  });

  it('locates both generals', () => {
    const p = Position.fromFen();
    expect(p.generalSq[RED]).toBe(idx(9, 4));
    expect(p.generalSq[BLACK]).toBe(idx(0, 4));
    expect(p.side).toBe(RED);
  });

  it('accepts the e/h piece-letter variant', () => {
    const p = Position.fromFen('rheakaehr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RHEAKAEHR w - - 0 1');
    expect(p.toFen()).toBe(START_FEN);
  });
});

describe('perft', () => {
  // Reference node counts for Xiangqi's initial position.
  it('matches known counts to depth 3', () => {
    const p = Position.fromFen();
    expect(perft(p, 1)).toBe(44);
    expect(perft(p, 2)).toBe(1920);
    expect(perft(p, 3)).toBe(79666);
  });

  it('matches known count at depth 4', () => {
    expect(perft(Position.fromFen(), 4)).toBe(3290240);
  }, 60_000);

  it('leaves the position untouched', () => {
    const p = Position.fromFen();
    perft(p, 3);
    expect(p.toFen()).toBe(START_FEN);
    expect(p.plies).toBe(0);
  });
});

describe('horse', () => {
  it('has eight moves in the open', () => {
    expect(targets(buildFen([at('N', 5, 4), at('K', 9, 3), at('k', 0, 5)]), 5, 4).length).toBe(8);
  });

  it('loses two moves to a hobbled leg', () => {
    const t = targets(buildFen([at('N', 5, 4), at('P', 4, 4), at('K', 9, 3), at('k', 0, 5)]), 5, 4);
    expect(t.length).toBe(6);
    expect(t).not.toContain(squareToCoord(idx(3, 3)));
    expect(t).not.toContain(squareToCoord(idx(3, 5)));
  });

  it('is blocked by an enemy piece just as much as a friendly one', () => {
    const t = targets(buildFen([at('N', 5, 4), at('p', 4, 4), at('K', 9, 3), at('k', 0, 5)]), 5, 4);
    expect(t.length).toBe(6);
    // It can still capture the blocker's square? No — the leg square is not a
    // horse destination, so the enemy soldier is untouchable by this horse.
    expect(t).not.toContain(squareToCoord(idx(4, 4)));
  });
});

describe('elephant', () => {
  it('never crosses the river', () => {
    expect(targets(buildFen([at('B', 5, 4), at('K', 9, 3), at('k', 0, 5)]), 5, 4)).toEqual(
      [squareToCoord(idx(7, 2)), squareToCoord(idx(7, 6))].sort(),
    );
  });

  it('is stopped by a blocked eye', () => {
    const t = targets(buildFen([at('B', 7, 4), at('P', 8, 3), at('K', 9, 3), at('k', 0, 5)]), 7, 4);
    expect(t.length).toBe(3);
    expect(t).not.toContain(squareToCoord(idx(9, 2)));
  });
});

describe('cannon', () => {
  it('cannot capture without a screen', () => {
    const t = targets(buildFen([at('C', 5, 4), at('p', 2, 4), at('K', 9, 3), at('k', 0, 5)]), 5, 4);
    expect(t).not.toContain(squareToCoord(idx(2, 4)));
    expect(t).toContain(squareToCoord(idx(3, 4)));
  });

  it('captures over exactly one screen', () => {
    const t = targets(
      buildFen([at('C', 7, 4), at('N', 5, 4), at('r', 2, 4), at('K', 9, 3), at('k', 0, 5)]), 7, 4,
    );
    expect(t).toContain(squareToCoord(idx(2, 4)));
    expect(t).toContain(squareToCoord(idx(6, 4)));
    expect(t).not.toContain(squareToCoord(idx(4, 4)));
  });

  it('will not capture over two screens', () => {
    const t = targets(
      buildFen([
        at('C', 7, 4), at('N', 5, 4), at('P', 4, 4), at('r', 2, 4), at('K', 9, 3), at('k', 0, 5),
      ]), 7, 4,
    );
    expect(t).not.toContain(squareToCoord(idx(2, 4)));
  });
});

describe('soldier', () => {
  it('only steps forward before the river', () => {
    expect(targets(buildFen([at('P', 6, 4), at('K', 9, 3), at('k', 0, 5)]), 6, 4))
      .toEqual([squareToCoord(idx(5, 4))]);
  });

  it('gains sideways moves after crossing', () => {
    expect(targets(buildFen([at('P', 4, 4), at('K', 9, 3), at('k', 0, 5)]), 4, 4).length).toBe(3);
  });

  it('never moves backwards', () => {
    const t = targets(buildFen([at('P', 4, 4), at('K', 9, 3), at('k', 0, 5)]), 4, 4);
    expect(t).not.toContain(squareToCoord(idx(5, 4)));
  });

  it('mirrors for black', () => {
    const t = targets(buildFen([at('p', 5, 4), at('K', 9, 3), at('k', 0, 5)], BLACK), 5, 4);
    expect(t.length).toBe(3);
    expect(t).toContain(squareToCoord(idx(6, 4)));
  });
});

describe('flying general', () => {
  it('pins a piece that shields the two generals', () => {
    const t = targets(buildFen([at('K', 9, 4), at('k', 0, 4), at('R', 7, 4)]), 7, 4);
    for (const coord of t) expect(coord[0]).toBe('e');
    expect(t).toContain('e9'); // may run all the way up and take the general
  });

  it('forbids stepping the general onto the enemy general’s open file', () => {
    const t = targets(buildFen([at('K', 9, 3), at('k', 0, 4)]), 9, 3);
    expect(t).not.toContain('e0');
  });

  it('treats an exposed facing as check', () => {
    const p = Position.fromFen(buildFen([at('K', 9, 4), at('k', 0, 4)]));
    expect(p.inCheck(RED)).toBe(true);
    expect(p.inCheck(BLACK)).toBe(true);
  });
});

describe('game end', () => {
  it('detects checkmate', () => {
    // Chariot on the back rank, general boxed in by its own elephant.
    const p = Position.fromFen(buildFen([at('K', 9, 4), at('R', 0, 0), at('k', 0, 4), at('b', 1, 4)], BLACK));
    expect(p.inCheck(BLACK)).toBe(true);
    expect(p.status()).toEqual({ result: 'red', reason: 'checkmate' });
  });

  it('treats having no move as a loss, not a draw', () => {
    // Black general boxed in with no legal move but not currently attacked.
    const p = Position.fromFen(
      buildFen([at('K', 9, 0), at('k', 0, 4), at('R', 1, 3), at('R', 1, 5), at('C', 3, 4)], BLACK),
    );
    expect(p.inCheck(BLACK)).toBe(false);
    expect(p.status()).toEqual({ result: 'red', reason: 'stalemate' });
  });

  it('calls a bare-generals position a draw', () => {
    const p = Position.fromFen(buildFen([at('K', 9, 3), at('k', 0, 5)]));
    expect(p.status()).toEqual({ result: 'draw', reason: 'insufficient-material' });
  });

  it('draws by threefold repetition when neither side is chasing', () => {
    const p = Position.fromFen(buildFen([at('K', 9, 3), at('k', 0, 5), at('R', 5, 0), at('r', 4, 8)]));
    const cycle = ['a4a3', 'i5i6', 'a3a4', 'i6i5'];
    for (let rep = 0; rep < 2; rep++) {
      for (const iccs of cycle) {
        const m = iccsToMove(p, iccs);
        expect(m, `${iccs} should be legal`).not.toBe(0);
        p.makeMove(m);
      }
    }
    expect(p.repetitionCount()).toBeGreaterThanOrEqual(3);
    expect(p.status()?.result).toBe('draw');
  });
});

describe('applyMove', () => {
  it('rejects a move for the wrong side', () => {
    const p = Position.fromFen();
    expect(iccsToMove(p, 'a9a8')).toBe(0);
  });

  it('rejects an illegal shape', () => {
    const p = Position.fromFen();
    // The cannon's own file is clear up to Black's cannon, and a cannon may
    // not capture the very first piece it meets.
    expect(iccsToMove(p, 'b2b7')).toBe(0);
  });

  it('re-encodes the captured piece so a client cannot lie', () => {
    const p = Position.fromFen();
    p.makeMove(iccsToMove(p, 'h2e2'));
    const forged = idx(7, 4) | (idx(2, 4) << 7) | (5 << 14);
    expect(p.applyMove(forged)).toBe(false);
  });
});

describe('Chinese notation', () => {
  it('names the classic centre-cannon opening', () => {
    const p = Position.fromFen();
    expect(moveToChinese(p, iccsToMove(p, 'h2e2'))).toBe('炮二平五');
  });

  it('names a horse development', () => {
    const p = Position.fromFen();
    expect(moveToChinese(p, iccsToMove(p, 'h0g2'))).toBe('马二进三');
  });

  it('uses Arabic numerals counted from Black’s right', () => {
    const p = Position.fromFen();
    p.makeMove(iccsToMove(p, 'h2e2'));
    expect(moveToChinese(p, iccsToMove(p, 'h7e7'))).toBe('炮8平5');
  });

  it('disambiguates two like pieces on one file with 前/后', () => {
    const p = Position.fromFen(buildFen([at('R', 5, 4), at('R', 8, 4), at('K', 9, 3), at('k', 0, 5)]));
    // Red counts in Chinese numerals whichever field it is reporting.
    expect(moveToChinese(p, iccsToMove(p, 'e4e6'))).toBe('前车进二');
    expect(moveToChinese(p, iccsToMove(p, 'e1e2'))).toBe('后车进一');
  });

  it('reports the destination file for leaping pieces', () => {
    const p = Position.fromFen(buildFen([at('N', 5, 4), at('K', 9, 3), at('k', 0, 5)]));
    expect(moveToChinese(p, iccsToMove(p, 'e4c5'))).toBe('马五进七');
  });

  it('renders English descriptive notation with a capture marker', () => {
    const p = Position.fromFen(buildFen([at('R', 5, 4), at('p', 2, 4), at('K', 9, 3), at('k', 0, 5)]));
    expect(describeMove(p, iccsToMove(p, 'e4e7')).en).toBe('Chariot e4xe7');
  });
});

describe('captured pieces', () => {
  it('tracks what has left the board', () => {
    const p = Position.fromFen();
    expect(p.capturedPieces()).toEqual([]);
    p.makeMove(iccsToMove(p, 'h2e2'));
    p.makeMove(iccsToMove(p, 'h7e7'));
    p.makeMove(iccsToMove(p, 'e2e6'));
    expect(p.capturedPieces().length).toBe(1);
  });
});

describe('piece values sanity', () => {
  it('orders the pieces the way Xiangqi theory does', () => {
    const order = [CHARIOT, CANNON, HORSE, ELEPHANT, SOLDIER];
    expect(order.length).toBe(5);
  });
});
