/**
 * Move notation. Two flavours, because the move list is bilingual:
 *  - ICCS coordinates ("h2e2") — the wire format, unambiguous and compact.
 *  - Traditional Chinese notation ("炮二平五") — what the move list shows in 中文.
 *  - English descriptive ("Cannon b2-e2") — what it shows in English.
 */
import { Position } from './position.js';
import {
  ADVISOR, CANNON, CHARIOT, ELEPHANT, EMPTY, GENERAL, HORSE, RED, SOLDIER, colOf, colorOf,
  encodeMove, moveFrom, moveTo, rowOf, typeOf, type Color, type Move, type Piece,
} from './types.js';

const FILES = 'abcdefghi';

/** Square -> ICCS coordinate. Rank 0 is Red's back rank. */
export const squareToCoord = (sq: number): string => `${FILES[colOf(sq)]}${9 - rowOf(sq)}`;

export const coordToSquare = (coord: string): number => {
  const col = FILES.indexOf(coord[0]!.toLowerCase());
  const rank = Number(coord[1]);
  if (col < 0 || Number.isNaN(rank) || rank < 0 || rank > 9) {
    throw new Error(`invalid coordinate: ${coord}`);
  }
  return (9 - rank) * 9 + col;
};

/** "h2e2" style, used on the wire and in game records. */
export const moveToIccs = (m: Move): string => `${squareToCoord(moveFrom(m))}${squareToCoord(moveTo(m))}`;

/** Parse an ICCS string against a position, returning NO_MOVE if illegal. */
export const iccsToMove = (pos: Position, iccs: string): Move => {
  if (iccs.length !== 4) return 0;
  const from = coordToSquare(iccs.slice(0, 2));
  const to = coordToSquare(iccs.slice(2, 4));
  return pos.findMove(from, to);
};

export const ZH_PIECE_CHAR: Record<number, string> = {
  [GENERAL]: '帅', [ADVISOR]: '仕', [ELEPHANT]: '相', [HORSE]: '马', [CHARIOT]: '车',
  [CANNON]: '炮', [SOLDIER]: '兵',
};
const ZH_PIECE_CHAR_BLACK: Record<number, string> = {
  [GENERAL]: '将', [ADVISOR]: '士', [ELEPHANT]: '象', [HORSE]: '马', [CHARIOT]: '车',
  [CANNON]: '炮', [SOLDIER]: '卒',
};

const ZH_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** Red counts files right-to-left in Chinese numerals; Black left-to-right in Arabic. */
const fileLabel = (col: number, color: Color): string =>
  color === RED ? ZH_DIGITS[9 - col]! : String(col + 1);
const stepLabel = (n: number, color: Color): string => (color === RED ? ZH_DIGITS[n]! : String(n));

const pieceChar = (piece: Piece): string =>
  (colorOf(piece) === RED ? ZH_PIECE_CHAR : ZH_PIECE_CHAR_BLACK)[typeOf(piece)]!;

/**
 * Chinese notation for a move, evaluated against the position *before* it.
 * Handles 前/后 disambiguation when two like pieces share a file, and the
 * front-to-back numbering used for three or more soldiers.
 */
export const moveToChinese = (pos: Position, move: Move): string => {
  const from = moveFrom(move);
  const to = moveTo(move);
  const piece = pos.pieceAt(from);
  if (piece === EMPTY) return moveToIccs(move);

  const color = colorOf(piece);
  const type = typeOf(piece);
  const name = pieceChar(piece);
  const fromCol = colOf(from);
  const fromRow = rowOf(from);
  const toRow = rowOf(to);
  const toCol = colOf(to);

  // Same-type friendly pieces sharing this file, ordered front-to-back.
  const sameFile: number[] = [];
  for (let r = 0; r < 10; r++) {
    const sq = r * 9 + fromCol;
    const p = pos.pieceAt(sq);
    if (p !== EMPTY && colorOf(p) === color && typeOf(p) === type) sameFile.push(sq);
  }
  // "Front" is toward the enemy: smaller row for Red, larger for Black.
  sameFile.sort((a, b) => (color === RED ? rowOf(a) - rowOf(b) : rowOf(b) - rowOf(a)));

  let subject: string;
  if (sameFile.length >= 2) {
    const rank = sameFile.indexOf(from);
    if (sameFile.length === 2) {
      subject = `${rank === 0 ? '前' : '后'}${name}`;
    } else if (sameFile.length === 3) {
      subject = `${['前', '中', '后'][rank]}${name}`;
    } else {
      subject = `${stepLabel(rank + 1, color)}${name}`;
    }
  } else {
    subject = `${name}${fileLabel(fromCol, color)}`;
  }

  if (toRow === fromRow) return `${subject}平${fileLabel(toCol, color)}`;

  const advancing = color === RED ? toRow < fromRow : toRow > fromRow;
  const dir = advancing ? '进' : '退';
  // Pieces that only travel along a file report distance; leapers and
  // diagonal movers report the destination file instead.
  const straight = type === CHARIOT || type === CANNON || type === SOLDIER || type === GENERAL;
  const value = straight
    ? stepLabel(Math.abs(toRow - fromRow), color)
    : fileLabel(toCol, color);
  return `${subject}${dir}${value}`;
};

export const EN_PIECE_NAME: Record<number, string> = {
  [GENERAL]: 'General', [ADVISOR]: 'Advisor', [ELEPHANT]: 'Elephant', [HORSE]: 'Horse',
  [CHARIOT]: 'Chariot', [CANNON]: 'Cannon', [SOLDIER]: 'Soldier',
};

/** "Cannon b2-e2", or "Chariot a0xa6" for a capture. */
export const moveToEnglish = (pos: Position, move: Move): string => {
  const from = moveFrom(move);
  const piece = pos.pieceAt(from);
  const name = piece === EMPTY ? 'Piece' : EN_PIECE_NAME[typeOf(piece)]!;
  const captured = pos.pieceAt(moveTo(move));
  const sep = captured === EMPTY ? '-' : 'x';
  return `${name} ${squareToCoord(from)}${sep}${squareToCoord(moveTo(move))}`;
};

/** Both renderings plus the wire form, computed before the move is applied. */
export interface MoveText {
  iccs: string;
  zh: string;
  en: string;
}

export const describeMove = (pos: Position, move: Move): MoveText => ({
  iccs: moveToIccs(move),
  zh: moveToChinese(pos, move),
  en: moveToEnglish(pos, move),
});

/** Build a move from raw squares without consulting legality. */
export const rawMove = (pos: Position, from: number, to: number): Move =>
  encodeMove(from, to, pos.pieceAt(to));
