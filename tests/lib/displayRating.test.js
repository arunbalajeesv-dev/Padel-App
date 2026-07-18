import { describe, it, expect } from 'vitest';

import { toDisplayRating } from '../../src/lib/displayRating.js';

const CONFIG = { displayScale: { ratingAtZero: 1000, ratingAtMax: 2500, maxUnits: 7 } };

describe('toDisplayRating', () => {
  it('maps the anchors exactly', () => {
    expect(toDisplayRating(1000, CONFIG)).toBe(0);
    expect(toDisplayRating(2500, CONFIG)).toBe(7);
  });

  it('puts the default 1500 start at ~2.33', () => {
    expect(toDisplayRating(1500, CONFIG)).toBeCloseTo(2.333, 3);
  });

  it('is linear — 214.3 rating points per display unit', () => {
    const perUnit = (2500 - 1000) / 7;

    expect(toDisplayRating(1000 + perUnit, CONFIG)).toBeCloseTo(1, 9);
    expect(toDisplayRating(1000 + 3 * perUnit, CONFIG)).toBeCloseTo(3, 9);
  });

  it('clamps below zero and above max rather than returning a nonsense scale', () => {
    expect(toDisplayRating(500, CONFIG)).toBe(0);
    expect(toDisplayRating(9000, CONFIG)).toBe(7);
  });

  it('is monotonic, so sorting by rating gives the display order', () => {
    // This is what lets the leaderboard sort on the stored rating without a
    // persisted ratingDisplay field.
    const ratings = [1100, 1300, 1500, 1800, 2100, 2400];
    const display = ratings.map((r) => toDisplayRating(r, CONFIG));

    for (let i = 1; i < display.length; i += 1) {
      expect(display[i]).toBeGreaterThan(display[i - 1]);
    }
  });

  it('does not round — rendering precision is Open Question 1, not this module\'s call', () => {
    expect(toDisplayRating(1512, CONFIG)).not.toBe(2.4);
    expect(toDisplayRating(1512, CONFIG)).toBeCloseTo(2.389, 3);
  });

  it('uses the injected anchors, not hardcoded ones', () => {
    const shifted = { displayScale: { ratingAtZero: 0, ratingAtMax: 700, maxUnits: 7 } };

    expect(toDisplayRating(300, shifted)).toBeCloseTo(3, 9);
  });

  it.each([
    ['ratingAtZero', { displayScale: { ratingAtMax: 2500, maxUnits: 7 } }],
    ['ratingAtMax', { displayScale: { ratingAtZero: 1000, maxUnits: 7 } }],
    ['maxUnits', { displayScale: { ratingAtZero: 1000, ratingAtMax: 2500 } }],
  ])('throws rather than producing NaN when %s is missing', (name, broken) => {
    expect(() => toDisplayRating(1500, broken)).toThrow(new RegExp(name));
  });

  it('throws on an inverted scale rather than dividing by a negative', () => {
    const inverted = { displayScale: { ratingAtZero: 2500, ratingAtMax: 1000, maxUnits: 7 } };

    expect(() => toDisplayRating(1500, inverted)).toThrow(/must exceed/);
  });

  it('throws on a non-numeric rating', () => {
    expect(() => toDisplayRating('1500', CONFIG)).toThrow(/rating/);
  });
});
