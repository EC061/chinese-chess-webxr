import { describe, expect, it } from 'vitest';
import {
  LESSONS, Position, colorOf, iccsToMove, EMPTY, RED, typeOf, squareToCoord,
} from '../src/index.js';

describe('tutorial lessons', () => {
  it('covers all seven piece types exactly once', () => {
    expect(LESSONS.length).toBe(7);
    expect(new Set(LESSONS.map((l) => l.type)).size).toBe(7);
  });

  for (const lesson of LESSONS) {
    describe(lesson.id, () => {
      it('has bilingual copy everywhere', () => {
        expect(lesson.title.zh.length).toBeGreaterThan(0);
        expect(lesson.title.en.length).toBeGreaterThan(0);
        expect(lesson.rules.length).toBeGreaterThan(1);
        for (const r of lesson.rules) {
          expect(r.zh.length).toBeGreaterThan(0);
          expect(r.en.length).toBeGreaterThan(0);
        }
      });

      it('demo boards parse, focus the right piece, and have moves to show', () => {
        for (const demo of lesson.demos) {
          const pos = Position.fromFen(demo.fen);
          const piece = pos.pieceAt(demo.focus);
          expect(piece, `${lesson.id}: focus square ${squareToCoord(demo.focus)} is empty`)
            .not.toBe(EMPTY);
          // Most demos focus the lesson's own piece, but a couple deliberately
          // focus a different piece to show a constraint acting on it (the
          // chariot pinned by 飞将, for instance).
          expect(colorOf(piece)).toBe(RED);
          expect(
            pos.legalTargets(demo.focus).length,
            `${lesson.id}: "${demo.caption.en}" has nothing to highlight`,
          ).toBeGreaterThan(0);
        }
      });

      it('focuses the lesson’s own piece in at least one demo', () => {
        const focused = lesson.demos.some((demo) => {
          const pos = Position.fromFen(demo.fen);
          return typeOf(pos.pieceAt(demo.focus)) === lesson.type;
        });
        expect(focused).toBe(true);
      });

      it('marks obstacles on squares that are actually occupied', () => {
        for (const demo of lesson.demos) {
          const pos = Position.fromFen(demo.fen);
          for (const o of demo.obstacles ?? []) {
            expect(pos.pieceAt(o), `${lesson.id}: obstacle ${squareToCoord(o)} is empty`)
              .not.toBe(EMPTY);
          }
        }
      });

      it('challenge solutions are legal and it is Red to move', () => {
        const { challenge } = lesson;
        expect(challenge.solutions.length).toBeGreaterThan(0);
        for (const solution of challenge.solutions) {
          const pos = Position.fromFen(challenge.fen);
          expect(pos.side).toBe(RED);
          const move = iccsToMove(pos, solution);
          expect(move, `${lesson.id}: solution ${solution} is not legal`).not.toBe(0);
        }
      });

      it('challenge uses the piece it is teaching', () => {
        const pos = Position.fromFen(lesson.challenge.fen);
        const first = lesson.challenge.solutions[0]!;
        const from = pos.pieceAt(
          (9 - Number(first[1])) * 9 + 'abcdefghi'.indexOf(first[0]!),
        );
        expect(typeOf(from)).toBe(lesson.type);
      });
    });
  }
});

describe('specific challenge outcomes', () => {
  it('the chariot lesson really is mate in one', () => {
    const lesson = LESSONS.find((l) => l.id === 'chariot')!;
    const pos = Position.fromFen(lesson.challenge.fen);
    pos.makeMove(iccsToMove(pos, lesson.challenge.solutions[0]!));
    expect(pos.status()).toEqual({ result: 'red', reason: 'checkmate' });
  });

  it('the advisor lesson really resolves the check', () => {
    const lesson = LESSONS.find((l) => l.id === 'advisor')!;
    const pos = Position.fromFen(lesson.challenge.fen);
    expect(pos.inCheck(RED)).toBe(true);
    pos.makeMove(iccsToMove(pos, lesson.challenge.solutions[0]!));
    expect(pos.inCheck(RED)).toBe(false);
  });

  it('the general lesson starts in check and every solution escapes it', () => {
    const lesson = LESSONS.find((l) => l.id === 'general')!;
    for (const solution of lesson.challenge.solutions) {
      const pos = Position.fromFen(lesson.challenge.fen);
      expect(pos.inCheck(RED)).toBe(true);
      pos.makeMove(iccsToMove(pos, solution));
      expect(pos.inCheck(RED)).toBe(false);
    }
  });

  it('the horse lesson forces the sideways route', () => {
    const lesson = LESSONS.find((l) => l.id === 'horse')!;
    const pos = Position.fromFen(lesson.challenge.fen);
    // The direct forward leaps are hobbled, so they must not appear at all.
    const legal = pos.legalTargets(5 * 9 + 4).map(squareToCoord);
    expect(legal).not.toContain('d6');
    expect(legal).not.toContain('f6');
    expect(legal).toContain('c5');
  });
});
