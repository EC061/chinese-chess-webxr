/**
 * Precomputed move tables, flattened into typed arrays.
 *
 * Every non-sliding piece gets its legal destination list baked in at module
 * load, which removes all off-board / palace / river edge cases from move
 * generation. The tables are stored as flat `Int8Array`s with a per-square
 * offset index rather than arrays of objects: this is the AI's inner loop, and
 * the difference between a boxed `{to, block}` and two typed-array reads is
 * roughly a factor of three on the whole search.
 *
 * Reading a table:
 *   for (let i = t.start[sq]; i < t.start[sq + 1]; i++) {
 *     const to = t.to[i];        // destination square
 *     const block = t.block[i];  // square that must be empty, or -1
 *   }
 */
import {
  BLACK, BOARD_SIZE, RED, crossedRiver, forwardOf, idx, inPalace, onBoard, colOf, rowOf,
  type Color,
} from './types.js';

export interface StepTable {
  /** Destination squares, grouped by origin square. */
  to: Int8Array;
  /** Square that must be empty for the step (马腿 / 象眼), or -1. */
  block: Int8Array;
  /** `start[sq]` .. `start[sq + 1]` bounds the entries for `sq`. Length 91. */
  start: Int32Array;
}

interface Step {
  to: number;
  block: number;
}

const buildStepTable = (per: (sq: number) => Step[]): StepTable => {
  const lists: Step[][] = [];
  let total = 0;
  for (let sq = 0; sq < BOARD_SIZE; sq++) {
    const list = per(sq);
    lists.push(list);
    total += list.length;
  }
  const table: StepTable = {
    to: new Int8Array(total),
    block: new Int8Array(total),
    start: new Int32Array(BOARD_SIZE + 1),
  };
  let i = 0;
  for (let sq = 0; sq < BOARD_SIZE; sq++) {
    table.start[sq] = i;
    for (const step of lists[sq]!) {
      table.to[i] = step.to;
      table.block[i] = step.block;
      i++;
    }
  }
  table.start[BOARD_SIZE] = i;
  return table;
};

/** Reverse a step table: which squares attack `target`, and with what block. */
const reverseStepTable = (forward: StepTable): StepTable => {
  const incoming: Step[][] = Array.from({ length: BOARD_SIZE }, () => []);
  for (let from = 0; from < BOARD_SIZE; from++) {
    for (let i = forward.start[from]!; i < forward.start[from + 1]!; i++) {
      // The block square belongs to the attacker's geometry, so it travels
      // with the origin rather than being mirrored.
      incoming[forward.to[i]!]!.push({ to: from, block: forward.block[i]! });
    }
  }
  return buildStepTable((sq) => incoming[sq]!);
};

const COLORS: Color[] = [RED, BLACK];
const byColor = (make: (color: Color) => StepTable): [StepTable, StepTable] =>
  [make(RED), make(BLACK)];

/** 帥/將 — one orthogonal step, never leaving the palace. */
export const GENERAL_STEPS = byColor((color) => buildStepTable((sq) => {
  const r = rowOf(sq);
  const c = colOf(sq);
  if (!inPalace(r, c, color)) return [];
  const out: Step[] = [];
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    if (inPalace(r + dr, c + dc, color)) out.push({ to: idx(r + dr, c + dc), block: -1 });
  }
  return out;
}));

/** 仕/士 — one diagonal step, never leaving the palace. */
export const ADVISOR_STEPS = byColor((color) => buildStepTable((sq) => {
  const r = rowOf(sq);
  const c = colOf(sq);
  if (!inPalace(r, c, color)) return [];
  const out: Step[] = [];
  for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as const) {
    if (inPalace(r + dr, c + dc, color)) out.push({ to: idx(r + dr, c + dc), block: -1 });
  }
  return out;
}));

/** 相/象 — the 田 step, blocked at 象眼, never crossing the river. */
export const ELEPHANT_STEPS = byColor((color) => buildStepTable((sq) => {
  const r = rowOf(sq);
  const c = colOf(sq);
  if (crossedRiver(r, color)) return [];
  const out: Step[] = [];
  for (const [dr, dc] of [[-2, -2], [-2, 2], [2, -2], [2, 2]] as const) {
    const nr = r + dr;
    const nc = c + dc;
    if (!onBoard(nr, nc) || crossedRiver(nr, color)) continue;
    out.push({ to: idx(nr, nc), block: idx(r + dr / 2, c + dc / 2) });
  }
  return out;
}));

/** 兵/卒 — forward always, sideways only after crossing the river. */
export const SOLDIER_STEPS = byColor((color) => buildStepTable((sq) => {
  const r = rowOf(sq);
  const c = colOf(sq);
  const out: Step[] = [];
  const fw = forwardOf(color);
  if (onBoard(r + fw, c)) out.push({ to: idx(r + fw, c), block: -1 });
  if (crossedRiver(r, color)) {
    if (onBoard(r, c - 1)) out.push({ to: idx(r, c - 1), block: -1 });
    if (onBoard(r, c + 1)) out.push({ to: idx(r, c + 1), block: -1 });
  }
  return out;
}));

/** 馬 — the 日 leap, blocked at 馬腿. Colour-independent. */
export const HORSE_STEPS = buildStepTable((sq) => {
  const r = rowOf(sq);
  const c = colOf(sq);
  const out: Step[] = [];
  for (const [dr, dc] of [
    [-2, -1], [-2, 1], [2, -1], [2, 1],
    [-1, -2], [-1, 2], [1, -2], [1, 2],
  ] as const) {
    const nr = r + dr;
    const nc = c + dc;
    if (!onBoard(nr, nc)) continue;
    // The leg is the orthogonal neighbour along the long axis of the L.
    const block = Math.abs(dr) === 2 ? idx(r + dr / 2, c) : idx(r, c + dc / 2);
    out.push({ to: idx(nr, nc), block });
  }
  return out;
});

/**
 * Sliding rays for 車 and 砲, flattened. Ray `dir` of square `sq` occupies
 * `RAY_START[sq * 4 + dir]` .. `RAY_START[sq * 4 + dir + 1]`, ordered outward.
 * Directions 0 and 1 are up and down the file, which is what the 飛將 check
 * relies on.
 */
const rayLists: number[][] = [];
for (let sq = 0; sq < BOARD_SIZE; sq++) {
  const r = rowOf(sq);
  const c = colOf(sq);
  for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    const ray: number[] = [];
    let nr = r + dr;
    let nc = c + dc;
    while (onBoard(nr, nc)) {
      ray.push(idx(nr, nc));
      nr += dr;
      nc += dc;
    }
    rayLists.push(ray);
  }
}
export const RAY_START = new Int32Array(BOARD_SIZE * 4 + 1);
export const RAY_TO = new Int8Array(rayLists.reduce((n, r) => n + r.length, 0));
{
  let i = 0;
  for (let k = 0; k < rayLists.length; k++) {
    RAY_START[k] = i;
    for (const sq of rayLists[k]!) RAY_TO[i++] = sq;
  }
  RAY_START[rayLists.length] = i;
}

/** Reverse tables: which squares of a given piece type attack a target. */
export const HORSE_ATTACKS = reverseStepTable(HORSE_STEPS);
export const SOLDIER_ATTACKS: [StepTable, StepTable] =
  [reverseStepTable(SOLDIER_STEPS[RED]), reverseStepTable(SOLDIER_STEPS[BLACK])];
export const ADVISOR_ATTACKS: [StepTable, StepTable] =
  [reverseStepTable(ADVISOR_STEPS[RED]), reverseStepTable(ADVISOR_STEPS[BLACK])];
export const ELEPHANT_ATTACKS: [StepTable, StepTable] =
  [reverseStepTable(ELEPHANT_STEPS[RED]), reverseStepTable(ELEPHANT_STEPS[BLACK])];
export const GENERAL_ATTACKS: [StepTable, StepTable] =
  [reverseStepTable(GENERAL_STEPS[RED]), reverseStepTable(GENERAL_STEPS[BLACK])];

export { COLORS };
