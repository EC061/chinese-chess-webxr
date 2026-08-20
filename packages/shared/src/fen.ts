/** Small helpers for composing the sparse boards the tutorial uses. */
import { RED, idx, type Color } from './types.js';

/** [fenChar, row, col] — uppercase is Red, lowercase is Black. */
export type Placement = readonly [string, number, number];

export const buildFen = (placements: readonly Placement[], side: Color = RED): string => {
  const cells: string[] = new Array(90).fill('');
  for (const [ch, row, col] of placements) {
    if (row < 0 || row > 9 || col < 0 || col > 8) {
      throw new Error(`placement out of bounds: ${ch} ${row},${col}`);
    }
    cells[idx(row, col)] = ch;
  }
  const ranks: string[] = [];
  for (let row = 0; row < 10; row++) {
    let s = '';
    let run = 0;
    for (let col = 0; col < 9; col++) {
      const ch = cells[idx(row, col)]!;
      if (!ch) { run++; continue; }
      if (run) { s += String(run); run = 0; }
      s += ch;
    }
    if (run) s += String(run);
    ranks.push(s);
  }
  return `${ranks.join('/')} ${side === RED ? 'w' : 'b'} - - 0 1`;
};
