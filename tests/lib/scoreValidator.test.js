import { describe, it, expect } from 'vitest';

import {
  validateScore,
  LEGAL_SET_ENDINGS,
  FORMAT,
} from '../../src/lib/scoreValidator.js';

const set = (teamA, teamB) => ({ teamA, teamB });

describe('legal set endings', () => {
  it.each(LEGAL_SET_ENDINGS)('accepts %i-%i for team A', (high, low) => {
    const result = validateScore([set(high, low)]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.winner).toBe('A');
  });

  it.each(LEGAL_SET_ENDINGS)('accepts %i-%i reversed, for team B', (high, low) => {
    const result = validateScore([set(low, high)]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.winner).toBe('B');
  });

  it('accepts every legal ending as a deciding third set', () => {
    for (const [high, low] of LEGAL_SET_ENDINGS) {
      const result = validateScore([set(6, 4), set(2, 6), set(high, low)]);

      expect(result.valid).toBe(true);
      expect(result.winner).toBe('A');
    }
  });
});

describe('illegal set endings', () => {
  it.each([
    [8, 6, 'a set that ran past 7'],
    [6, 5, 'a set stopped a game early'],
    [5, 3, 'an unfinished set'],
    [7, 4, 'a 7 that should have been a 6'],
    [9, 7, 'an extended set'],
    [1, 0, 'a barely-started set'],
    [7, 7, 'a level score above the tiebreak'],
  ])('rejects %i-%i (%s)', (teamA, teamB) => {
    const result = validateScore([set(teamA, teamB)]);

    expect(result.valid).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.format).toBeNull();
    expect(result.errors).toHaveLength(1);
  });

  it.each([
    [6, 6],
    [0, 0],
    [7, 7],
  ])('rejects the level score %i-%i with a dedicated message', (teamA, teamB) => {
    const result = validateScore([set(teamA, teamB)]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/cannot end level/);
  });

  it('names the offending set', () => {
    const result = validateScore([set(6, 4), set(6, 5)]);

    expect(result.errors[0]).toMatch(/^Set 2:/);
  });

  it('lists the legal endings so the UI can guide the player', () => {
    const result = validateScore([set(8, 6)]);

    expect(result.errors[0]).toMatch(/6-0, 6-1, 6-2, 6-3, 6-4, 7-5, 7-6/);
  });

  it('reports each illegal set separately', () => {
    const result = validateScore([set(8, 6), set(6, 5)]);

    expect(result.errors.filter((e) => e.startsWith('Set '))).toHaveLength(2);
  });

  it.each([
    ['negative games', set(-1, 6)],
    ['fractional games', set(6.5, 4)],
    ['a non-numeric score', set('6', 4)],
    ['a null score', set(null, 4)],
    ['NaN', set(NaN, 4)],
  ])('rejects %s', (_label, badSet) => {
    const result = validateScore([badSet]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/whole numbers/);
  });
});

describe('championship tiebreaks', () => {
  it('rejects a 10-8 third set by name', () => {
    const result = validateScore([set(6, 4), set(2, 6), set(10, 8)]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/championship tiebreak/i);
    expect(result.errors[0]).toMatch(/not supported/i);
  });

  it.each([
    [10, 8],
    [10, 5],
    [11, 9],
    [12, 10],
    [10, 0],
  ])('rejects a %i-%i third set as a tiebreak', (teamA, teamB) => {
    const result = validateScore([set(6, 4), set(2, 6), set(teamA, teamB)]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/championship tiebreak/i);
  });

  it('rejects a tiebreak the other way round', () => {
    const result = validateScore([set(6, 4), set(2, 6), set(8, 10)]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/championship tiebreak/i);
  });

  it('still points at the third set when the tiebreak is won by team B', () => {
    const result = validateScore([set(6, 4), set(2, 6), set(8, 10)]);

    expect(result.errors[0]).toMatch(/^Set 3:/);
  });
});

describe('set count', () => {
  it('rejects zero sets', () => {
    const result = validateScore([]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/at least one set/);
    expect(result.format).toBeNull();
  });

  it('rejects four sets', () => {
    const result = validateScore([set(6, 4), set(2, 6), set(6, 3), set(6, 2)]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/more than three sets/);
  });

  it('rejects a non-array score', () => {
    const result = validateScore(null);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must be an array of sets/);
  });
});

describe('formats', () => {
  it('derives single from a one-set match', () => {
    expect(validateScore([set(6, 4)]).format).toBe(FORMAT.SINGLE);
  });

  it('derives threeSet from a straight-sets win', () => {
    expect(validateScore([set(6, 4), set(6, 2)]).format).toBe(FORMAT.THREE_SET);
  });

  it('derives threeSet from a full-distance match', () => {
    expect(validateScore([set(6, 4), set(2, 6), set(7, 5)]).format).toBe(
      FORMAT.THREE_SET,
    );
  });

  it('treats a straight-sets 2-0 as threeSet, not a discounted format', () => {
    // A 2-0 win is a completed best-of-three and counts 1.0x, not 0.65x.
    const result = validateScore([set(6, 0), set(6, 0)]);

    expect(result.format).toBe(FORMAT.THREE_SET);
    expect(result.valid).toBe(true);
  });
});

describe('set sequence coherence', () => {
  it('rejects a two-set match split one apiece as unfinished', () => {
    const result = validateScore([set(6, 4), set(3, 6)]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/not finished/i);
    expect(result.errors[0]).toMatch(/third set/i);
  });

  it('rejects a third set after team A already won the first two', () => {
    const result = validateScore([set(6, 4), set(6, 2), set(6, 3)]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/should have ended after two sets/i);
    expect(result.errors[0]).toMatch(/Team A/);
  });

  it('rejects a third set after team B already won the first two', () => {
    const result = validateScore([set(4, 6), set(2, 6), set(3, 6)]);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Team B/);
  });

  it('accepts a genuine three-set comeback', () => {
    const result = validateScore([set(4, 6), set(6, 3), set(7, 6)]);

    expect(result.valid).toBe(true);
    expect(result.winner).toBe('A');
  });

  it('does not stack sequence errors on top of an illegal set', () => {
    // 6-5 is illegal; the winner is unknown, so claiming the match is
    // unfinished as well would just be noise.
    const result = validateScore([set(6, 4), set(6, 5)]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^Set 2:/);
  });
});

describe('winner', () => {
  it('picks the straight-sets winner', () => {
    expect(validateScore([set(6, 4), set(6, 2)]).winner).toBe('A');
    expect(validateScore([set(4, 6), set(2, 6)]).winner).toBe('B');
  });

  it('picks the deciding-set winner in a three-setter', () => {
    expect(validateScore([set(6, 4), set(2, 6), set(6, 3)]).winner).toBe('A');
    expect(validateScore([set(6, 4), set(2, 6), set(3, 6)]).winner).toBe('B');
  });

  it('is null whenever the score is invalid', () => {
    expect(validateScore([set(6, 5)]).winner).toBeNull();
    expect(validateScore([]).winner).toBeNull();
  });
});

describe('total games', () => {
  it('sums games across sets for the margin multiplier', () => {
    const result = validateScore([set(6, 4), set(2, 6), set(7, 6)]);

    expect(result.gamesA).toBe(15);
    expect(result.gamesB).toBe(16);
  });

  it('counts a 7-6 set as 13 games, ignoring tiebreak points', () => {
    const result = validateScore([set(7, 6)]);

    expect(result.gamesA + result.gamesB).toBe(13);
  });

  it('reports games even when the score is invalid, so the UI can echo it back', () => {
    const result = validateScore([set(8, 6)]);

    expect(result.valid).toBe(false);
    expect(result.gamesA).toBe(8);
    expect(result.gamesB).toBe(6);
  });

  it('gives a 6-0 6-0 win the maximum margin ratio of 1', () => {
    const { gamesA, gamesB } = validateScore([set(6, 0), set(6, 0)]);
    const ratio = (gamesA - gamesB) / (gamesA + gamesB);

    expect(ratio).toBe(1);
  });
});

describe('purity', () => {
  it('does not mutate the input', () => {
    const sets = [set(6, 4), set(6, 2)];
    const before = structuredClone(sets);

    validateScore(sets);

    expect(sets).toEqual(before);
  });

  it('returns the same result for the same input', () => {
    const sets = [set(6, 4), set(2, 6), set(7, 5)];

    expect(validateScore(sets)).toEqual(validateScore(sets));
  });
});
