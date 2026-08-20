/**
 * Zobrist hashing with two 32-bit halves. Avoiding BigInt keeps the search
 * allocation-free, and the split maps naturally onto a shared-memory
 * transposition table: the low word indexes the bucket, the high word verifies.
 * The PRNG is seeded so client and server always agree on a position's key.
 */
import { BOARD_SIZE } from './types.js';

const seedRandom = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
};

const rnd = seedRandom(0x9e3779b9);

export const ZOB_LO = new Int32Array(16 * BOARD_SIZE);
export const ZOB_HI = new Int32Array(16 * BOARD_SIZE);
for (let i = 0; i < 16 * BOARD_SIZE; i++) {
  ZOB_LO[i] = rnd() | 0;
  ZOB_HI[i] = rnd() | 0;
}
export const ZOB_SIDE_LO = rnd() | 0;
export const ZOB_SIDE_HI = rnd() | 0;

export const zobIndex = (piece: number, square: number): number => piece * BOARD_SIZE + square;
