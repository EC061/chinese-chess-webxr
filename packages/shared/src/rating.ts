/**
 * Glicko-2 ratings. Chosen over plain Elo because this app has two very
 * different sources of games — humans and a fixed-strength AI — and Glicko-2's
 * rating deviation lets a new player converge fast while keeping a veteran's
 * rating stable. AI games count, but the AI's own rating never moves.
 */

export interface Rating {
  /** Displayed rating. */
  rating: number;
  /** Rating deviation — uncertainty. Above PROVISIONAL_RD we show a "?" badge. */
  rd: number;
  /** Volatility — how erratic the player's results have been. */
  volatility: number;
}

export const DEFAULT_RATING: Rating = { rating: 1500, rd: 350, volatility: 0.06 };
export const PROVISIONAL_RD = 110;
/** System constant: smaller = volatility changes more slowly. */
const TAU = 0.5;
const SCALE = 173.7178;
const EPSILON = 0.000001;

/** Score from the perspective of the first player. */
export type Score = 0 | 0.5 | 1;

/** Strength the AI is treated as having at each level, for rating purposes. */
export const AI_LEVEL_RATING: Record<number, number> = {
  1: 700, 2: 950, 3: 1150, 4: 1350, 5: 1550, 6: 1750, 7: 1950, 8: 2200,
};
/** The AI is a known quantity, so its games carry a tight deviation. */
export const AI_RD = 60;

export const isProvisional = (r: Rating): boolean => r.rd > PROVISIONAL_RD;

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number): number =>
  1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * One rating period containing a single game — which is how this server runs,
 * updating immediately after each result so players see movement right away.
 */
export const updateRating = (player: Rating, opponent: Rating, score: Score): Rating => {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.volatility;

  const muJ = (opponent.rating - 1500) / SCALE;
  const phiJ = opponent.rd / SCALE;

  const gJ = g(phiJ);
  const e = expected(mu, muJ, phiJ);

  const v = 1 / (gJ * gJ * e * (1 - e));
  const delta = v * gJ * (score - e);

  // Illinois-algorithm solve for the new volatility.
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0 && k < 100) k++;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPSILON && guard++ < 200) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }

  const newSigma = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gJ * (score - e);

  return {
    rating: Math.round((newMu * SCALE + 1500) * 10) / 10,
    // Floor the deviation so an active player never becomes unmovable.
    rd: Math.round(Math.min(350, Math.max(30, newPhi * SCALE)) * 10) / 10,
    volatility: Math.round(newSigma * 1000000) / 1000000,
  };
};

/** Rating an AI level is treated as having. */
export const aiRating = (level: number): Rating => ({
  rating: AI_LEVEL_RATING[Math.min(8, Math.max(1, Math.round(level)))] ?? 1500,
  rd: AI_RD,
  volatility: 0.06,
});

/** Conservative display value, the way most ladders rank provisional players. */
export const displayRating = (r: Rating): number => Math.round(r.rating);
export const conservativeRating = (r: Rating): number => Math.round(r.rating - 2 * r.rd);
