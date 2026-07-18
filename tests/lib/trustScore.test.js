import { describe, it, expect } from 'vitest';

import { normaliseScore, aggregateTrust } from '../../src/lib/trustScore.js';
import { VALID_CONFIG as CONFIG } from '../fixtures/config.js';

const entries = (...scores) => scores.map((score) => ({ score }));

describe('normaliseScore', () => {
  it.each([
    [1, 0],
    [2, 0.25],
    [3, 0.5],
    [4, 0.75],
    [5, 1],
  ])('maps %i to %f', (raw, expected) => {
    expect(normaliseScore(raw)).toBe(expected);
  });

  it('rejects a score outside the 1-5 scale', () => {
    expect(() => normaliseScore(0)).toThrow(/outside the 1-5 scale/);
    expect(() => normaliseScore(6)).toThrow(/outside the 1-5 scale/);
  });
});

describe('aggregateTrust — the shrunk mean', () => {
  it('is exactly neutral (0.5) with no feedback', () => {
    const agg = aggregateTrust([], CONFIG);
    expect(agg.trustScore).toBe(0.5);
    expect(agg.reviewCount).toBe(0);
    // rawMean null distinguishes "neutral because unrated" from "neutral because middling".
    expect(agg.rawMean).toBeNull();
  });

  it('pulls a single bad review toward, not to, the floor', () => {
    // One 1-star (normalised 0) with prior weight 5: (0 + 5*0.5)/(1+5) = 0.4167.
    const agg = aggregateTrust(entries(1), CONFIG);
    expect(agg.trustScore).toBeCloseTo(2.5 / 6, 5);
    expect(agg.trustScore).toBeGreaterThan(0.4); // nudged, not condemned
    expect(agg.rawMean).toBe(0);
  });

  it('approaches the raw mean as reviews accumulate', () => {
    const few = aggregateTrust(entries(5, 5), CONFIG).trustScore;
    const many = aggregateTrust(entries(...Array(50).fill(5)), CONFIG).trustScore;

    expect(many).toBeGreaterThan(few);
    expect(many).toBeGreaterThan(0.9);
    expect(many).toBeLessThan(1);
  });

  it('cannot be inflated by volume of neutral reviews', () => {
    // 100 reviews of 3 (neutral) stay at 0.5, exactly the prior.
    expect(aggregateTrust(entries(...Array(100).fill(3)), CONFIG).trustScore).toBe(0.5);
  });

  it('stays within [0,1] at both extremes', () => {
    expect(aggregateTrust(entries(...Array(20).fill(1)), CONFIG).trustScore).toBeGreaterThan(0);
    expect(aggregateTrust(entries(...Array(20).fill(5)), CONFIG).trustScore).toBeLessThan(1);
  });

  it('reads the prior weight from config', () => {
    const strong = { ...CONFIG, trustScorePriorWeight: 100 };
    // A huge prior weight keeps even a run of 5s near neutral.
    expect(aggregateTrust(entries(5, 5, 5), strong).trustScore).toBeLessThan(0.6);
  });

  it('throws when the prior weight is missing rather than defaulting', () => {
    const { trustScorePriorWeight, ...withoutK } = CONFIG;
    expect(() => aggregateTrust(entries(5), withoutK)).toThrow(/trustScorePriorWeight/);
  });
});
