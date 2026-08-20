# Optional external engine

The built-in AI is written in TypeScript and runs in Web Workers on the headset,
so nothing needs to go here for the game to work.

If you would rather play a stronger engine, drop a UCI engine compiled to
WebAssembly in this directory — Pikafish and Fairy-Stockfish (Xiangqi variant)
both work — and point the client at its loader:

    VITE_UCI_ENGINE_URL=/engines/pikafish/pikafish.js

The adapter in `packages/ai/src/engine.ts` (`UciEngine`) speaks plain UCI over
`postMessage`, translates difficulty levels to `movetime` / `UCI_Elo`, and
implements the same `Engine` interface as the built-in searcher, so no game code
changes. Check the licence of whatever you vendor here — this repository ships
none of it.
