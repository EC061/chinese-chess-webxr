import { describe, expect, it } from 'vitest';
import { AI_LEVEL_RATING, DEFAULT_RATING, aiRating, isProvisional, updateRating } from '../src/index.js';

describe('glicko-2', () => {
  it('rewards beating a stronger opponent more than a weaker one', () => {
    const strong = updateRating(DEFAULT_RATING, { rating: 1900, rd: 60, volatility: 0.06 }, 1);
    const weak = updateRating(DEFAULT_RATING, { rating: 1100, rd: 60, volatility: 0.06 }, 1);
    expect(strong.rating).toBeGreaterThan(weak.rating);
    expect(strong.rating).toBeGreaterThan(DEFAULT_RATING.rating);
  });

  it('penalises losing to a weaker opponent', () => {
    const r = updateRating(DEFAULT_RATING, { rating: 1100, rd: 60, volatility: 0.06 }, 0);
    expect(r.rating).toBeLessThan(DEFAULT_RATING.rating);
  });

  it('shrinks the deviation as games accumulate', () => {
    let r = DEFAULT_RATING;
    expect(isProvisional(r)).toBe(true);
    for (let i = 0; i < 30; i++) {
      r = updateRating(r, { rating: 1500, rd: 60, volatility: 0.06 }, i % 2 === 0 ? 1 : 0);
    }
    expect(r.rd).toBeLessThan(DEFAULT_RATING.rd);
    expect(isProvisional(r)).toBe(false);
    // Alternating results against an equal opponent should stay near 1500.
    expect(Math.abs(r.rating - 1500)).toBeLessThan(80);
  });

  it('never lets the deviation collapse to zero', () => {
    let r = DEFAULT_RATING;
    for (let i = 0; i < 500; i++) r = updateRating(r, { rating: 1500, rd: 30, volatility: 0.06 }, 0.5);
    expect(r.rd).toBeGreaterThanOrEqual(30);
  });

  it('converges upward against a beatable AI level', () => {
    let r = DEFAULT_RATING;
    for (let i = 0; i < 20; i++) r = updateRating(r, aiRating(6), 1);
    expect(r.rating).toBeGreaterThan(AI_LEVEL_RATING[6]!);
  });

  it('treats a draw against an equal as roughly neutral', () => {
    const r = updateRating({ rating: 1600, rd: 60, volatility: 0.06 }, { rating: 1600, rd: 60, volatility: 0.06 }, 0.5);
    expect(Math.abs(r.rating - 1600)).toBeLessThan(1);
  });
});
