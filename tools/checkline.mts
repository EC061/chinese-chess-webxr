import { Position, START_FEN, iccsToMove, moveToChinese } from '../packages/shared/src/index.js';
const moves = process.argv.slice(2);
const pos = Position.fromFen(START_FEN);
for (const iccs of moves) {
  const m = iccsToMove(pos, iccs);
  if (m === 0) { console.log(`ILLEGAL: ${iccs} (after ${pos.plies} plies)\n${pos.toFen()}`); process.exit(1); }
  console.log(`${String(pos.plies + 1).padStart(2)}. ${iccs}  ${moveToChinese(pos, m)}`);
  pos.applyMove(m);
}
console.log('all legal; status =', JSON.stringify(pos.status()));
