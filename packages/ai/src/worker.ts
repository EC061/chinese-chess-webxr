/**
 * Search worker body. Kept free of any direct `self` reference at module scope
 * so the same code can be unit-tested on the main thread; the client installs
 * it into a real Worker with {@link installWorkerHandler}.
 */
import { Position, START_FEN, iccsToMove, moveToIccs, type Move } from '@ccx/shared';
import { chooseMove } from './choose.js';
import { levelSpec } from './levels.js';
import { Searcher, mateDistance } from './search.js';
import { STOP_INDEX, TranspositionTable } from './tt.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';

export interface WorkerScope {
  postMessage(message: WorkerResponse): void;
}

export const createWorkerHandler = (scope: WorkerScope) => {
  let searcher: Searcher | null = null;
  let control: Int32Array | undefined;
  let threadIndex = 0;

  const rebuild = (startFen: string, moves: string[]): Position => {
    const pos = Position.fromFen(startFen || START_FEN);
    for (const iccs of moves) {
      const move = iccsToMove(pos, iccs);
      if (move === 0) throw new Error(`illegal move in history: ${iccs}`);
      pos.makeMove(move);
    }
    return pos;
  };

  return (request: WorkerRequest): void => {
    switch (request.cmd) {
      case 'init': {
        threadIndex = request.threadIndex;
        const tt = new TranspositionTable(request.ttSizeMb, request.ttBuffer);
        control = request.controlBuffer ? new Int32Array(request.controlBuffer) : undefined;
        searcher = new Searcher({ tt, control, threadIndex });
        scope.postMessage({ type: 'ready', threadIndex, shared: Boolean(request.ttBuffer) });
        return;
      }

      case 'newgame': {
        searcher?.newGame();
        return;
      }

      case 'stop': {
        if (control) control[STOP_INDEX] = 1;
        return;
      }

      case 'search': {
        if (!searcher) throw new Error('worker used before init');
        if (control) control[STOP_INDEX] = 0;

        const spec = levelSpec(request.level);
        const pos = rebuild(request.startFen, request.moves);
        const depth = request.limits?.depth ?? spec.depth;
        const timeMs = request.limits?.timeMs ?? spec.timeMs;

        const toIccs = (move: Move): string => (move === 0 ? '' : moveToIccs(move));

        const result = searcher.search(pos, { depth, timeMs });
        const choice = request.primary
          ? chooseMove(pos, result.rootScores, spec)
          : { move: result.bestMove, bestMove: result.bestMove, deviated: false };

        scope.postMessage({
          type: 'result',
          id: request.id,
          iccs: toIccs(choice.move),
          bestIccs: toIccs(choice.bestMove),
          deviated: choice.deviated,
          score: result.score,
          depth: result.depth,
          nodes: result.nodes,
          timeMs: result.timeMs,
          pv: result.pv.map(toIccs).filter(Boolean),
          mateIn: mateDistance(result.score),
          // Only the top handful is useful to the UI, and it keeps messages small.
          rootScores: result.rootScores.slice(0, 8).map((r) => ({ iccs: toIccs(r.move), score: r.score })),
        });
        return;
      }
    }
  };
};

/** Wire the handler up to a real DedicatedWorkerGlobalScope. */
export const installWorkerHandler = (scope: {
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: { data: WorkerRequest }) => void) | null;
}): void => {
  const handle = createWorkerHandler(scope);
  scope.onmessage = (event) => handle(event.data);
};
