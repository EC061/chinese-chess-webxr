/**
 * Engine benchmark. Run with `npx tsx tools/bench.mts`.
 * Useful for checking a change did not cost strength or speed; the numbers to
 * watch are nps (raw speed) and the effective branching factor between depths
 * (ordering quality — anything near sqrt(branching) is close to optimal).
 */
import { Position, moveToIccs } from '../packages/shared/src/index.js';
import { Searcher, TranspositionTable, levelSpec } from '../packages/ai/src/index.js';

const fen = process.argv[2];
let previous = 0;

for (const level of [3, 5, 6, 7, 8]) {
  const spec = levelSpec(level);
  const pos = fen ? Position.fromFen(fen) : Position.fromFen();
  const searcher = new Searcher({ tt: new TranspositionTable(spec.ttSizeMb) });
  const r = searcher.search(pos, { depth: spec.depth, timeMs: spec.timeMs });
  const nps = Math.round(r.nodes / (r.timeMs / 1000));
  const ebf = previous ? (r.nodes / previous).toFixed(1) : '-';
  previous = r.nodes;
  console.log(
    `L${level} ${spec.label.en.padEnd(12)} depth=${String(r.depth).padStart(2)} `
    + `nodes=${String(r.nodes).padStart(9)} ${r.timeMs.toFixed(0).padStart(5)}ms `
    + `${String(Math.round(nps / 1000)).padStart(4)}k nps  ebf=${ebf.padStart(4)}  `
    + `best=${moveToIccs(r.bestMove)} score=${r.score}`,
  );
}
