/**
 * Static evaluation, in centipawns where a soldier is 100.
 *
 * Piece-square tables are written from Red's point of view with row 0 at the
 * top (the enemy back rank) and row 9 at the bottom (own back rank), which is
 * exactly the board's own indexing for Red. Black reads the same table through
 * a vertical mirror.
 */
import {
  ADVISOR, BLACK, BOARD_SIZE, CANNON, CHARIOT, ELEPHANT, EMPTY, GENERAL, HORSE, RED, SOLDIER,
  colOf, colorOf, crossedRiver, idx, rowOf, typeOf, type Color, type Piece, type Position,
} from '@ccx/shared';

export const MATE_SCORE = 30000;
export const MATE_THRESHOLD = MATE_SCORE - 200;
export const DRAW_SCORE = 0;

export const PIECE_VALUE: Record<number, number> = {
  [GENERAL]: 15000,
  [ADVISOR]: 200,
  [ELEPHANT]: 220,
  [HORSE]: 430,
  [CHARIOT]: 950,
  [CANNON]: 470,
  [SOLDIER]: 100,
};

/** Flatten a readable 10x9 literal into a square-indexed table. */
const table = (rows: number[][]): Int16Array => {
  if (rows.length !== 10) throw new Error('PST must have 10 rows');
  const t = new Int16Array(BOARD_SIZE);
  for (let r = 0; r < 10; r++) {
    const row = rows[r]!;
    if (row.length !== 9) throw new Error(`PST row ${r} must have 9 columns`);
    for (let c = 0; c < 9; c++) t[idx(r, c)] = row[c]!;
  }
  return t;
};

/** Soldiers: worth roughly double past the river, and best aimed at the palace. */
const PST_SOLDIER = table([
  [ 9,  9,  9, 11, 13, 11,  9,  9,  9],
  [19, 24, 34, 42, 44, 42, 34, 24, 19],
  [19, 24, 32, 37, 37, 37, 32, 24, 19],
  [19, 23, 27, 29, 30, 29, 27, 23, 19],
  [14, 18, 20, 27, 29, 27, 20, 18, 14],
  [ 7,  0, 13,  0, 16,  0, 13,  0,  7],
  [ 7,  0,  7,  0, 15,  0,  7,  0,  7],
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0],
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0],
  [ 0,  0,  0,  0,  0,  0,  0,  0,  0],
]);

/** Horses want open ground and the two attacking squares near the palace. */
const PST_HORSE = table([
  [ 0, -4,  0,  0,  0,  0,  0, -4,  0],
  [ 0,  2,  4,  4, -2,  4,  4,  2,  0],
  [ 4,  2,  8,  8,  4,  8,  8,  2,  4],
  [ 2,  6,  8,  6, 10,  6,  8,  6,  2],
  [ 4, 12, 16, 14, 12, 14, 16, 12,  4],
  [ 6, 16, 14, 18, 16, 18, 14, 16,  6],
  [ 8, 12, 18, 16, 22, 16, 18, 12,  8],
  [ 4, 10, 28, 16,  8, 16, 28, 10,  4],
  [ 4,  8, 16, 12,  4, 12, 16,  8,  4],
  [ 2,  2,  2,  8,  2,  8,  2,  2,  2],
]);

/** Chariots: centre files and the enemy back rank. */
const PST_CHARIOT = table([
  [-2, 10,  6, 14, 12, 14,  6, 10, -2],
  [ 8,  4,  8, 16,  8, 16,  8,  4,  8],
  [ 4,  8,  6, 14, 12, 14,  6,  8,  4],
  [ 6, 10,  8, 14, 14, 14,  8, 10,  6],
  [12, 16, 14, 20, 20, 20, 14, 16, 12],
  [12, 14, 12, 18, 18, 18, 12, 14, 12],
  [12, 18, 16, 22, 22, 22, 16, 18, 12],
  [12, 12, 12, 18, 18, 18, 12, 12, 12],
  [16, 20, 18, 24, 26, 24, 18, 20, 16],
  [14, 14, 12, 18, 16, 18, 12, 14, 14],
]);

/** Cannons: the centre file is gold, and sitting behind your own palace is not. */
const PST_CANNON = table([
  [ 0,  0,  2,  6,  6,  6,  2,  0,  0],
  [ 0,  2,  4,  6,  6,  6,  4,  2,  0],
  [ 4,  0,  8,  6, 10,  6,  8,  0,  4],
  [ 0,  0,  0,  2,  4,  2,  0,  0,  0],
  [-2,  0,  4,  2,  6,  2,  4,  0, -2],
  [ 0,  0,  0,  2,  8,  2,  0,  0,  0],
  [ 0,  0, -2,  4, 10,  4, -2,  0,  0],
  [ 2,  2,  0,-10, -8,-10,  0,  2,  2],
  [ 2,  2,  0, -4,-14, -4,  0,  2,  2],
  [ 6,  4,  0,-10,-12,-10,  0,  4,  6],
]);

/** Advisors and elephants: stay home, stay connected. */
const PST_ADVISOR = table([
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 6, 0, 0, 0, 0],
  [0, 0, 0, 4, 0, 4, 0, 0, 0],
]);

const PST_ELEPHANT = table([
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 3, 0, 0, 0, 3, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 6, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 4, 0, 0, 0, 4, 0, 0],
]);

/** Generals: stay tucked in the back of the palace while the board is busy. */
const PST_GENERAL = table([
  [0, 0, 0,   0,   0,   0, 0, 0, 0],
  [0, 0, 0,   0,   0,   0, 0, 0, 0],
  [0, 0, 0,   0,   0,   0, 0, 0, 0],
  [0, 0, 0,   0,   0,   0, 0, 0, 0],
  [0, 0, 0,   0,   0,   0, 0, 0, 0],
  [0, 0, 0,   0,   0,   0, 0, 0, 0],
  [0, 0, 0,   0,   0,   0, 0, 0, 0],
  [0, 0, 0, -12, -14, -12, 0, 0, 0],
  [0, 0, 0,  -6,  -8,  -6, 0, 0, 0],
  [0, 0, 0,   2,   4,   2, 0, 0, 0],
]);

const PST_BY_TYPE: Int16Array[] = [];
PST_BY_TYPE[GENERAL] = PST_GENERAL;
PST_BY_TYPE[ADVISOR] = PST_ADVISOR;
PST_BY_TYPE[ELEPHANT] = PST_ELEPHANT;
PST_BY_TYPE[HORSE] = PST_HORSE;
PST_BY_TYPE[CHARIOT] = PST_CHARIOT;
PST_BY_TYPE[CANNON] = PST_CANNON;
PST_BY_TYPE[SOLDIER] = PST_SOLDIER;

/** Vertical mirror, so Black can read Red's tables. */
const MIRROR = new Int8Array(BOARD_SIZE);
for (let sq = 0; sq < BOARD_SIZE; sq++) MIRROR[sq] = idx(9 - rowOf(sq), colOf(sq));

/**
 * Everything the evaluation loop needs, keyed by the full piece code (0..15)
 * and already signed for its owner. Indexing a flat typed array rather than a
 * `Record` keyed by piece type turned out to be worth roughly 40x on the
 * evaluation, which dominates the search's leaf cost.
 */
const PIECE_SCORE = new Int32Array(16);
const PIECE_ABS = new Int32Array(16);
const PST_FLAT = new Int16Array(16 * BOARD_SIZE);
for (let type = GENERAL; type <= SOLDIER; type++) {
  const value = PIECE_VALUE[type] ?? 0;
  const pst = PST_BY_TYPE[type]!;
  for (const color of [RED, BLACK] as Color[]) {
    const piece = type | (color << 3);
    const sign = color === RED ? 1 : -1;
    // The general's material value is excluded: it can never be traded, and a
    // huge number in the material sum only destabilises the search window.
    PIECE_SCORE[piece] = type === GENERAL ? 0 : sign * value;
    PIECE_ABS[piece] = value;
    for (let sq = 0; sq < BOARD_SIZE; sq++) {
      PST_FLAT[piece * BOARD_SIZE + sq] = sign * pst[color === RED ? sq : MIRROR[sq]!]!;
    }
  }
}

export const pieceValue = (piece: Piece): number => PIECE_ABS[piece]!;

/** Positional value of a piece on a square, from its owner's perspective. */
export const pstValue = (piece: Piece, square: number): number =>
  Math.abs(PST_FLAT[piece * BOARD_SIZE + square]!);

const RED_CHARIOT = CHARIOT | (RED << 3);
const BLACK_CHARIOT = CHARIOT | (BLACK << 3);
const RED_ADVISOR = ADVISOR | (RED << 3);
const BLACK_ADVISOR = ADVISOR | (BLACK << 3);
const RED_ELEPHANT = ELEPHANT | (RED << 3);
const BLACK_ELEPHANT = ELEPHANT | (BLACK << 3);
const RED_SOLDIER = SOLDIER | (RED << 3);
const BLACK_SOLDIER = SOLDIER | (BLACK << 3);

/** Reusable scratch, safe because a searcher evaluates one position at a time. */
const COUNTS = new Int32Array(16);
const RED_CANNONS = new Int32Array(8);
const BLACK_CANNONS = new Int32Array(8);

/**
 * Evaluate from the perspective of the side to move; positive means the mover
 * is better off. Positive terms are Red's throughout, and the sign is flipped
 * once at the end.
 */

export const evaluate = (pos: Position): number => {
  const b = pos.board;
  let score = 0;
  let redCannonCount = 0;
  let blackCannonCount = 0;
  COUNTS.fill(0);

  for (let sq = 0; sq < BOARD_SIZE; sq++) {
    const piece = b[sq]!;
    if (piece === EMPTY) continue;
    score += PIECE_SCORE[piece]! + PST_FLAT[piece * BOARD_SIZE + sq]!;
    COUNTS[piece]!++;
    if ((piece & 7) === CANNON) {
      if ((piece >> 3) === RED) {
        if (redCannonCount < 8) RED_CANNONS[redCannonCount++] = sq;
      } else if (blackCannonCount < 8) {
        BLACK_CANNONS[blackCannonCount++] = sq;
      }
    }
  }

  const redChariots = COUNTS[RED_CHARIOT]!;
  const blackChariots = COUNTS[BLACK_CHARIOT]!;

  // 缺士怕双车 — a general short of advisors is badly exposed to heavy pieces.
  const redMissing = 2 - COUNTS[RED_ADVISOR]!;
  if (redMissing > 0) score -= redMissing * (12 + 14 * blackChariots + 10 * blackCannonCount);
  const blackMissing = 2 - COUNTS[BLACK_ADVISOR]!;
  if (blackMissing > 0) score += blackMissing * (12 + 14 * redChariots + 10 * redCannonCount);

  const redElephants = COUNTS[RED_ELEPHANT]!;
  if (redElephants === 2) score += 12;
  else if (redElephants === 0) score -= 8 * blackCannonCount;
  const blackElephants = COUNTS[BLACK_ELEPHANT]!;
  if (blackElephants === 2) score -= 12;
  else if (blackElephants === 0) score += 8 * redCannonCount;

  // 空头炮 — a cannon aimed down an open file at the enemy general.
  for (let i = 0; i < redCannonCount; i++) score += hollowCannonBonus(pos, RED_CANNONS[i]!, RED);
  for (let i = 0; i < blackCannonCount; i++) score -= hollowCannonBonus(pos, BLACK_CANNONS[i]!, BLACK);

  score += Math.min(COUNTS[RED_SOLDIER]!, 2) * 4;
  score -= Math.min(COUNTS[BLACK_SOLDIER]!, 2) * 4;

  // Plus a small tempo bonus, which keeps the search from dithering.
  return (pos.side === RED ? score : -score) + 6;
};

/** Bonus for a cannon staring down an open file at the enemy general. */
const hollowCannonBonus = (pos: Position, cannonSq: number, color: Color): number => {
  const enemyGeneral = pos.generalSq[color === RED ? BLACK : RED];
  if (enemyGeneral < 0) return 0;
  if (colOf(cannonSq) !== colOf(enemyGeneral)) return 0;

  const step = enemyGeneral > cannonSq ? 9 : -9;
  let between = 0;
  for (let sq = cannonSq + step; sq !== enemyGeneral; sq += step) {
    if (pos.board[sq] !== EMPTY) between++;
    if (between > 1) return 0;
  }
  // Nothing in between at all is the devastating 空头炮; one screen is a live threat.
  return between === 0 ? 55 : 18;
};

/** Rough game phase in [0,1], 1 = opening. Used to taper general safety. */
export const phaseOf = (pos: Position): number => {
  let heavy = 0;
  for (let sq = 0; sq < BOARD_SIZE; sq++) {
    const p = pos.board[sq]!;
    if (p === EMPTY) continue;
    const t = typeOf(p);
    if (t === CHARIOT) heavy += 3;
    else if (t === CANNON || t === HORSE) heavy += 2;
  }
  return Math.min(1, heavy / 14);
};

/** Does this side still have anything that can force a win? */
export const hasAttackingMaterial = (pos: Position, color: Color): boolean => {
  for (let sq = 0; sq < BOARD_SIZE; sq++) {
    const p = pos.board[sq]!;
    if (p === EMPTY || colorOf(p) !== color) continue;
    const t = typeOf(p);
    if (t === CHARIOT || t === CANNON || t === HORSE) return true;
    if (t === SOLDIER && crossedRiver(rowOf(sq), color)) return true;
  }
  return false;
};
