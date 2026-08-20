/** Engine construction: the on-device searcher, or an external UCI/WASM build. */
import { LocalEngine, UciEngine, recommendedThreads, type Engine } from '@ccx/ai';

const workerFactory = () =>
  new Worker(new URL('../ai/searchWorker.ts', import.meta.url), {
    type: 'module',
    name: 'xiangqi-search',
  });

/**
 * Set `VITE_UCI_ENGINE_URL` at build time to play an external engine instead.
 * See `public/engines/README.md`.
 */
const UCI_URL = import.meta.env.VITE_UCI_ENGINE_URL as string | undefined;

export const createEngine = (): Engine => {
  if (UCI_URL) {
    return new UciEngine({
      scriptUrl: UCI_URL,
      options: { Threads: String(recommendedThreads()), Hash: '64' },
      levelToUci: (spec) => ({
        movetime: spec.timeMs,
        depth: spec.depth,
        // Map our eight levels onto the engine's own strength limiter.
        elo: spec.level < 8 ? spec.rating : undefined,
      }),
    });
  }
  return new LocalEngine({ workerFactory, ttSizeMb: 64 });
};

export const engineLabel = (engine: Engine): string =>
  engine.kind === 'uci' ? 'UCI/WASM' : `${engine.threads}× worker${engine.shared ? ' (shared table)' : ''}`;
