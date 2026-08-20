/**
 * Board geometry, in metres. These numbers are chosen to match a real tabletop
 * Xiangqi board (about 45 x 50 cm with 4.2 cm pieces) so that reaching across it
 * in VR feels like reaching across the real thing.
 *
 * The board lies in the XZ plane. Red sits at +Z, which is why Red's home rank
 * (row 9) is the one with the largest Z: "forward" for Red is -Z, away from the
 * seated player.
 */
export const CELL = 0.048;
export const MARGIN = 0.032;
export const BOARD_WIDTH = 8 * CELL + 2 * MARGIN;
export const BOARD_HEIGHT = 9 * CELL + 2 * MARGIN;
export const BOARD_THICKNESS = 0.014;

export const PIECE_RADIUS = 0.021;
export const PIECE_HEIGHT = 0.009;
/** How high a piece floats while being carried. */
export const PIECE_LIFT = 0.045;

export const TABLE_HEIGHT = 0.72;
export const TABLE_RADIUS = 0.42;
/** Distance from the board centre to a player's seat. */
export const SEAT_DISTANCE = 0.62;

export const BOARD_Y = TABLE_HEIGHT + BOARD_THICKNESS;

/** Square index (row * 9 + col) to a position on the board surface. */
export const squareToPosition = (square: number): [number, number, number] => {
  const row = Math.floor(square / 9);
  const col = square % 9;
  return [(col - 4) * CELL, 0, (row - 4.5) * CELL];
};

/** Local XZ on the board surface back to the nearest square, or -1 if outside. */
export const positionToSquare = (x: number, z: number): number => {
  const col = Math.round(x / CELL + 4);
  const row = Math.round(z / CELL + 4.5);
  if (col < 0 || col > 8 || row < 0 || row > 9) return -1;
  return row * 9 + col;
};

export const squareRow = (square: number): number => Math.floor(square / 9);
export const squareCol = (square: number): number => square % 9;
