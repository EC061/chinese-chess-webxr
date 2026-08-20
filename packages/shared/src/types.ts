/** Core board vocabulary for 中国象棋 (Xiangqi).
 *
 * Board is a flat 90-cell array. `index = row * 9 + col`.
 *   row 0  = Black's back rank (top of the screen)
 *   row 9  = Red's back rank (bottom of the screen)
 *   col 0  = file 'a' (viewer's left)   col 8 = file 'i'
 * The river runs between rows 4 and 5.
 */

export const RED = 0;
export const BLACK = 1;
export type Color = typeof RED | typeof BLACK;

export const EMPTY = 0;
export const GENERAL = 1;
export const ADVISOR = 2;
export const ELEPHANT = 3;
export const HORSE = 4;
export const CHARIOT = 5;
export const CANNON = 6;
export const SOLDIER = 7;
export type PieceType = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A piece is `type | (color << 3)`, so 1..7 are Red and 9..15 are Black. */
export type Piece = number;

export const makePiece = (type: PieceType, color: Color): Piece => type | (color << 3);
export const typeOf = (p: Piece): PieceType => (p & 7) as PieceType;
export const colorOf = (p: Piece): Color => ((p >> 3) & 1) as Color;
export const other = (c: Color): Color => (c ^ 1) as Color;

export const BOARD_SIZE = 90;
export const idx = (row: number, col: number): number => row * 9 + col;
export const rowOf = (i: number): number => (i / 9) | 0;
export const colOf = (i: number): number => i % 9;
export const onBoard = (row: number, col: number): boolean =>
  row >= 0 && row < 10 && col >= 0 && col < 9;

/** Palace: rows 7..9 for Red, rows 0..2 for Black; cols 3..5 for both. */
export const inPalace = (row: number, col: number, color: Color): boolean =>
  col >= 3 && col <= 5 && (color === RED ? row >= 7 && row <= 9 : row >= 0 && row <= 2);

/** True once the piece has crossed to the opponent's half of the board. */
export const crossedRiver = (row: number, color: Color): boolean =>
  color === RED ? row <= 4 : row >= 5;

/** Forward row delta: Red advances toward row 0, Black toward row 9. */
export const forwardOf = (color: Color): number => (color === RED ? -1 : 1);

/**
 * A move is packed into one integer so the search can store millions of them
 * without allocating:  from (7b) | to (7b) << 7 | captured piece (4b) << 14
 */
export type Move = number;
export const NO_MOVE = 0;
export const encodeMove = (from: number, to: number, captured: Piece): Move =>
  from | (to << 7) | (captured << 14);
export const moveFrom = (m: Move): number => m & 0x7f;
export const moveTo = (m: Move): number => (m >> 7) & 0x7f;
export const moveCaptured = (m: Move): Piece => (m >> 14) & 0xf;
export const isCapture = (m: Move): boolean => ((m >> 14) & 0xf) !== 0;

export type GameResult = 'red' | 'black' | 'draw';
export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'repetition'
  | 'no-capture-limit'
  | 'insufficient-material'
  | 'resignation'
  | 'timeout'
  | 'abandoned'
  | 'agreement';

export interface GameOver {
  result: GameResult;
  reason: EndReason;
}
