/**
 * Difficulty levels. Strength is dialled with four independent knobs so the
 * lower levels feel like a human beginner rather than a lobotomised engine:
 *
 *  depth/timeMs  — how far ahead it actually looks
 *  evalNoise     — centipawns of random noise added to each root move's score,
 *                  which makes it prefer a slightly worse move now and then
 *  blunderChance — probability of ignoring the search entirely and playing a
 *                  random legal move, the way a beginner overlooks a threat
 *  avoidMateIn1  — whether a random pick is still checked for immediate mate
 */
import { AI_LEVEL_RATING } from '@ccx/shared';

export interface LevelSpec {
  level: number;
  /** Bilingual label for the level selector. */
  label: { zh: string; en: string };
  depth: number;
  timeMs: number;
  evalNoise: number;
  blunderChance: number;
  avoidMateIn1: boolean;
  /** Search threads. Quest 3's XR2 Gen 2 has cores to spare, but the render
   *  loop must keep 72-90 fps, so even the top level leaves headroom. */
  threads: number;
  ttSizeMb: number;
  /** Approximate rating, used for the ladder and shown in the UI. */
  rating: number;
}

const spec = (
  level: number, zh: string, en: string, depth: number, timeMs: number,
  evalNoise: number, blunderChance: number, avoidMateIn1: boolean, threads: number, ttSizeMb: number,
): LevelSpec => ({
  level, label: { zh, en }, depth, timeMs, evalNoise, blunderChance, avoidMateIn1, threads,
  ttSizeMb, rating: AI_LEVEL_RATING[level] ?? 1500,
});

export const LEVELS: LevelSpec[] = [
  spec(1, '新手', 'Beginner', 1, 150, 90, 0.35, false, 1, 2),
  spec(2, '入门', 'Novice', 2, 250, 65, 0.20, true, 1, 4),
  spec(3, '业余', 'Casual', 3, 400, 45, 0.10, true, 1, 8),
  spec(4, '棋友', 'Club', 4, 700, 28, 0.04, true, 1, 16),
  spec(5, '高手', 'Strong', 6, 1200, 14, 0.01, true, 2, 32),
  spec(6, '好手', 'Expert', 9, 2200, 6, 0, true, 2, 48),
  spec(7, '大师', 'Master', 14, 4000, 0, 0, true, 3, 64),
  spec(8, '特级大师', 'Grandmaster', 24, 8000, 0, 0, true, 3, 96),
];

export const levelSpec = (level: number): LevelSpec =>
  LEVELS[Math.min(LEVELS.length, Math.max(1, Math.round(level))) - 1]!;
