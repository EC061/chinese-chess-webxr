/**
 * Main-thread engine facade.
 *
 * `LocalEngine` runs the search entirely on the headset. When the page is
 * cross-origin isolated it allocates the transposition table in a
 * SharedArrayBuffer and runs several workers against it (Lazy SMP): helpers do
 * not report moves, they just deepen the shared table so the primary thread
 * reaches a higher depth in the same wall-clock budget. Without cross-origin
 * isolation it degrades cleanly to a single worker with a private table.
 *
 * `UciEngine` implements the same interface against an external UCI engine
 * compiled to WebAssembly, so a stronger backend can be dropped in later
 * without touching any game code.
 */
import { levelSpec, type LevelSpec } from './levels.js';
import { CONTROL_WORDS, STOP_INDEX, TranspositionTable } from './tt.js';
import type { WorkerRequest, WorkerResponse, WorkerResult } from './protocol.js';

export interface SearchRequest {
  startFen: string;
  moves: string[];
  level: number;
  limits?: { depth?: number; timeMs?: number };
}

export interface SearchOutcome {
  iccs: string;
  bestIccs: string;
  deviated: boolean;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  pv: string[];
  mateIn: number | null;
}

export interface Engine {
  readonly kind: string;
  readonly threads: number;
  /** True when a SharedArrayBuffer table is in play. */
  readonly shared: boolean;
  init(): Promise<void>;
  newGame(): void;
  bestMove(request: SearchRequest): Promise<SearchOutcome>;
  stop(): void;
  dispose(): void;
  onProgress?: (info: { depth: number; score: number; nodes: number; timeMs: number; pv: string[] }) => void;
}

export type WorkerFactory = () => Worker;

export interface LocalEngineOptions {
  workerFactory: WorkerFactory;
  /** Cap on search threads; defaults to leaving 2 cores for the render loop. */
  maxThreads?: number;
  /** Table size in MB. Ignored per-level cap applies on top. */
  ttSizeMb?: number;
}

/** Leave headroom so the 72-90 Hz XR render loop never starves. */
export const recommendedThreads = (max?: number): number => {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;
  const budget = Math.max(1, cores - 2);
  return Math.max(1, Math.min(max ?? budget, budget, 4));
};

const canShareMemory = (): boolean =>
  typeof SharedArrayBuffer !== 'undefined'
  && (typeof globalThis.crossOriginIsolated === 'undefined' || globalThis.crossOriginIsolated === true);

export class LocalEngine implements Engine {
  readonly kind = 'local';
  onProgress?: Engine['onProgress'];

  private readonly factory: WorkerFactory;
  private readonly maxThreads: number;
  private readonly ttSizeMb: number;
  private workers: Worker[] = [];
  private control?: Int32Array;
  private ttBuffer?: SharedArrayBuffer;
  private controlBuffer?: SharedArrayBuffer;
  private nextId = 1;
  private pending: Map<number, { resolve: (r: SearchOutcome) => void; reject: (e: Error) => void }> = new Map();
  private ready = false;
  private isShared = false;

  constructor(options: LocalEngineOptions) {
    this.factory = options.workerFactory;
    this.maxThreads = recommendedThreads(options.maxThreads);
    this.ttSizeMb = options.ttSizeMb ?? 64;
  }

  get threads(): number {
    return this.workers.length;
  }

  get shared(): boolean {
    return this.isShared;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    this.isShared = canShareMemory();
    const threads = this.isShared ? this.maxThreads : 1;

    if (this.isShared) {
      this.ttBuffer = new SharedArrayBuffer(TranspositionTable.bytesFor(this.ttSizeMb));
      this.controlBuffer = new SharedArrayBuffer(CONTROL_WORDS * 4);
      this.control = new Int32Array(this.controlBuffer);
    }

    const readyPromises: Promise<void>[] = [];
    for (let i = 0; i < threads; i++) {
      const worker = this.factory();
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handleMessage(event.data);
      worker.onerror = (event) => {
        for (const [, p] of this.pending) p.reject(new Error(`search worker failed: ${event.message ?? 'unknown'}`));
        this.pending.clear();
      };
      this.workers.push(worker);
      readyPromises.push(new Promise<void>((resolve) => {
        const onReady = (event: MessageEvent<WorkerResponse>) => {
          if (event.data.type === 'ready') {
            worker.removeEventListener('message', onReady);
            resolve();
          }
        };
        worker.addEventListener('message', onReady);
      }));
      this.post(worker, {
        cmd: 'init',
        threadIndex: i,
        ttBuffer: this.ttBuffer,
        controlBuffer: this.controlBuffer,
        ttSizeMb: this.ttSizeMb,
      });
    }

    await Promise.all(readyPromises);
    this.ready = true;
  }

  newGame(): void {
    for (const worker of this.workers) this.post(worker, { cmd: 'newgame' });
  }

  async bestMove(request: SearchRequest): Promise<SearchOutcome> {
    if (!this.ready) await this.init();
    const spec: LevelSpec = levelSpec(request.level);
    const id = this.nextId++;
    if (this.control) this.control[STOP_INDEX] = 0;

    const promise = new Promise<SearchOutcome>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    // Only the primary worker's answer is used; the rest just warm the table.
    const helpers = this.isShared ? Math.min(spec.threads, this.workers.length) : 1;
    for (let i = 0; i < helpers; i++) {
      this.post(this.workers[i]!, {
        cmd: 'search',
        id: i === 0 ? id : -id,
        startFen: request.startFen,
        moves: request.moves,
        level: request.level,
        limits: request.limits,
        primary: i === 0,
      });
    }

    const outcome = await promise;
    // The primary has answered, so the helpers can stand down.
    this.stop();
    return outcome;
  }

  stop(): void {
    if (this.control) this.control[STOP_INDEX] = 1;
    else for (const worker of this.workers) this.post(worker, { cmd: 'stop' });
  }

  dispose(): void {
    this.stop();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.pending.clear();
    this.ready = false;
  }

  private post(worker: Worker, message: WorkerRequest): void {
    worker.postMessage(message);
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.type === 'progress') {
      if (message.id > 0) this.onProgress?.(message);
      return;
    }
    if (message.type !== 'result') return;
    const result = message as WorkerResult;
    // Helper searches carry a negative id and are discarded.
    if (result.id < 0) return;
    const waiter = this.pending.get(result.id);
    if (!waiter) return;
    this.pending.delete(result.id);
    waiter.resolve({
      iccs: result.iccs,
      bestIccs: result.bestIccs,
      deviated: result.deviated,
      score: result.score,
      depth: result.depth,
      nodes: result.nodes,
      timeMs: result.timeMs,
      pv: result.pv,
      mateIn: result.mateIn,
    });
  }
}

/**
 * Adapter for an external UCI engine compiled to WebAssembly (Pikafish or
 * Fairy-Stockfish, for instance). Nothing in the app depends on which engine is
 * in use — drop a build under /engines and point ENGINE_UCI_URL at it.
 */
export interface UciEngineOptions {
  /** URL of the engine's JS loader, which must expose a UCI text interface. */
  scriptUrl: string;
  /** Extra UCI options to send after `uci`. */
  options?: Record<string, string | number>;
  /** Map a level to UCI limits. */
  levelToUci?: (spec: LevelSpec) => { movetime: number; depth?: number; elo?: number };
}

export class UciEngine implements Engine {
  readonly kind = 'uci';
  readonly shared = false;
  onProgress?: Engine['onProgress'];

  private worker: Worker | null = null;
  private lines: string[] = [];
  private waiters: Array<(line: string) => boolean> = [];

  constructor(private readonly options: UciEngineOptions) {}

  get threads(): number {
    return this.worker ? 1 : 0;
  }

  async init(): Promise<void> {
    if (this.worker) return;
    // A classic worker, because UCI wasm builds ship as classic scripts.
    this.worker = new Worker(this.options.scriptUrl);
    this.worker.onmessage = (event: MessageEvent<string>) => this.onLine(String(event.data));
    this.send('uci');
    await this.waitFor((line) => line.startsWith('uciok'));
    for (const [key, value] of Object.entries(this.options.options ?? {})) {
      this.send(`setoption name ${key} value ${value}`);
    }
    this.send('isready');
    await this.waitFor((line) => line.startsWith('readyok'));
  }

  newGame(): void {
    this.send('ucinewgame');
  }

  async bestMove(request: SearchRequest): Promise<SearchOutcome> {
    const spec = levelSpec(request.level);
    const uci = this.options.levelToUci?.(spec) ?? { movetime: spec.timeMs, depth: spec.depth };
    if (uci.elo !== undefined) {
      this.send('setoption name UCI_LimitStrength value true');
      this.send(`setoption name UCI_Elo value ${uci.elo}`);
    }
    const moves = request.moves.length ? ` moves ${request.moves.join(' ')}` : '';
    this.send(`position fen ${request.startFen}${moves}`);
    const depth = request.limits?.depth ?? uci.depth;
    const movetime = request.limits?.timeMs ?? uci.movetime;
    this.send(`go movetime ${movetime}${depth ? ` depth ${depth}` : ''}`);

    let score = 0;
    let seenDepth = 0;
    let pv: string[] = [];
    const best = await this.waitForValue((line) => {
      if (line.startsWith('info')) {
        const cp = /score cp (-?\d+)/.exec(line);
        if (cp) score = Number(cp[1]);
        const d = /\bdepth (\d+)/.exec(line);
        if (d) seenDepth = Number(d[1]);
        const p = / pv (.+)$/.exec(line);
        if (p) pv = p[1]!.trim().split(/\s+/);
        this.onProgress?.({ depth: seenDepth, score, nodes: 0, timeMs: 0, pv });
        return null;
      }
      const m = /^bestmove\s+(\S+)/.exec(line);
      return m ? m[1]! : null;
    });

    const mate = /score mate (-?\d+)/.exec(this.lines.join('\n'));
    return {
      iccs: best,
      bestIccs: best,
      deviated: false,
      score,
      depth: seenDepth,
      nodes: 0,
      timeMs: movetime,
      pv,
      mateIn: mate ? Number(mate[1]) : null,
    };
  }

  stop(): void {
    this.send('stop');
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private send(command: string): void {
    this.worker?.postMessage(command);
  }

  private onLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.shift();
    this.waiters = this.waiters.filter((w) => !w(line));
  }

  private waitFor(predicate: (line: string) => boolean): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push((line) => {
        if (!predicate(line)) return false;
        resolve();
        return true;
      });
    });
  }

  private waitForValue<T>(extract: (line: string) => T | null): Promise<T> {
    return new Promise((resolve) => {
      this.waiters.push((line) => {
        const value = extract(line);
        if (value === null) return false;
        resolve(value);
        return true;
      });
    });
  }
}
