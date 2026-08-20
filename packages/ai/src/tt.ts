/**
 * Transposition table sized in power-of-two buckets, laid out over a raw
 * buffer so several search workers can share one table (Lazy SMP) when the
 * page is cross-origin isolated and a SharedArrayBuffer is available.
 *
 * Three 32-bit words per entry:
 *   w0 = keyHi ^ w2   (lockless verification: a torn write fails the check)
 *   w1 = packed move
 *   w2 = score | depth | flag
 *
 * Plain aligned 32-bit element access is used rather than Atomics: the JS
 * memory model guarantees such a read observes some complete write, and a
 * mismatched (move, data) pair is caught downstream because every table move
 * is re-validated for legality before use.
 */

export const TT_EXACT = 0;
export const TT_LOWER = 1; // score is a lower bound (fail high / beta cutoff)
export const TT_UPPER = 2; // score is an upper bound (fail low)

const WORDS_PER_ENTRY = 3;
const SCORE_BIAS = 32768;

export interface TtProbe {
  hit: boolean;
  move: number;
  score: number;
  depth: number;
  flag: number;
}

export class TranspositionTable {
  private readonly data: Int32Array;
  private readonly mask: number;

  /**
   * @param sizeMb Target size in megabytes; rounded down to a power of two.
   * @param buffer Pass a SharedArrayBuffer to share the table across workers.
   */
  constructor(sizeMb = 16, buffer?: ArrayBufferLike) {
    const bytesPerEntry = WORDS_PER_ENTRY * 4;
    const wanted = Math.max(1024, Math.floor((sizeMb * 1024 * 1024) / bytesPerEntry));
    const entries = 1 << Math.floor(Math.log2(wanted));
    this.mask = entries - 1;
    this.data = buffer
      ? new Int32Array(buffer, 0, entries * WORDS_PER_ENTRY)
      : new Int32Array(entries * WORDS_PER_ENTRY);
  }

  /** Bytes needed to back a table of the given size, for allocating a SAB. */
  static bytesFor(sizeMb: number): number {
    const bytesPerEntry = WORDS_PER_ENTRY * 4;
    const wanted = Math.max(1024, Math.floor((sizeMb * 1024 * 1024) / bytesPerEntry));
    return (1 << Math.floor(Math.log2(wanted))) * bytesPerEntry;
  }

  clear(): void {
    this.data.fill(0);
  }

  probe(hashLo: number, hashHi: number, out: TtProbe): TtProbe {
    const base = (hashLo & this.mask) * WORDS_PER_ENTRY;
    const w0 = this.data[base]!;
    const w2 = this.data[base + 2]!;
    if (w0 === 0 && w2 === 0) { out.hit = false; return out; }
    if ((w0 ^ w2) !== hashHi) { out.hit = false; return out; }
    out.hit = true;
    out.move = this.data[base + 1]!;
    out.score = (w2 & 0xffff) - SCORE_BIAS;
    out.depth = (w2 >>> 16) & 0x3f;
    out.flag = (w2 >>> 22) & 0x3;
    return out;
  }

  store(
    hashLo: number, hashHi: number, move: number, score: number, depth: number, flag: number,
  ): void {
    const base = (hashLo & this.mask) * WORDS_PER_ENTRY;
    const clamped = Math.max(-32000, Math.min(32000, Math.round(score)));
    const d = Math.max(0, Math.min(63, depth));

    // Depth-preferred replacement, but always overwrite a different position.
    const existing = this.data[base + 2]!;
    if (existing !== 0 && (this.data[base]! ^ existing) === hashHi) {
      const existingDepth = (existing >>> 16) & 0x3f;
      if (existingDepth > d && ((existing >>> 22) & 0x3) === TT_EXACT) return;
    }

    const w2 = ((clamped + SCORE_BIAS) & 0xffff) | (d << 16) | (flag << 22);
    this.data[base] = hashHi ^ w2;
    this.data[base + 1] = move;
    this.data[base + 2] = w2;
  }
}

/** Shared control block: [0] = stop flag, [1] = nodes searched by helpers. */
export const CONTROL_WORDS = 4;
export const STOP_INDEX = 0;
