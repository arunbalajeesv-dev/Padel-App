import { describe, it, expect, vi } from 'vitest';

import { makeFirestore } from '../fixtures/fakeFirestore.js';

let db;
vi.mock('../../src/config/firebase.js', () => ({
  getFirestore: () => db,
  getAuth: () => ({}),
}));

const { sideStats, dominantSide } = await import('../../src/services/matchesService.js');

/**
 * `dominantSide` is pure, so it is tested directly on counts — no database,
 * no fixtures. The rule it encodes is a product decision, not arithmetic:
 * say nothing until there is enough evidence on BOTH sides.
 */
describe('dominantSide — only claims a side when the data supports it', () => {
  const counts = (l, lw, r, rw) => ({
    left: { matches: l, wins: lw },
    right: { matches: r, wins: rw },
  });

  it('returns the better side once both sides have enough matches', () => {
    expect(dominantSide(counts(4, 3, 4, 1))).toBe('left');
    expect(dominantSide(counts(4, 1, 4, 3))).toBe('right');
  });

  it('returns null when either side is under the minimum sample', () => {
    // A 100% win rate from two matches is not evidence of a dominant side.
    expect(dominantSide(counts(2, 2, 9, 4))).toBeNull();
    expect(dominantSide(counts(9, 4, 2, 2))).toBeNull();
    expect(dominantSide(counts(0, 0, 0, 0))).toBeNull();
  });

  it('returns null on an exact tie rather than picking arbitrarily', () => {
    expect(dominantSide(counts(4, 2, 4, 2))).toBeNull();
    // Different totals, identical rate — still a tie.
    expect(dominantSide(counts(4, 2, 8, 4))).toBeNull();
  });
});

describe('sideStats — counts wins per side from confirmed matches', () => {
  const match = (over) => ({
    teamA: ['me', 'a2'],
    teamB: ['b1', 'b2'],
    players: ['me', 'a2', 'b1', 'b2'],
    status: 'confirmed',
    winner: 'A',
    sides: { me: 'left', a2: 'right', b1: 'left', b2: 'right' },
    ...over,
  });

  it('separates wins and losses by the side the player was on', () => {
    db = makeFirestore({
      'matches/m1': match({ sides: { me: 'left', a2: 'right', b1: 'left', b2: 'right' }, winner: 'A' }),
      'matches/m2': match({ sides: { me: 'left', a2: 'right', b1: 'left', b2: 'right' }, winner: 'B' }),
      'matches/m3': match({ sides: { me: 'right', a2: 'left', b1: 'left', b2: 'right' }, winner: 'A' }),
    });

    return sideStats('me').then((counts) => {
      expect(counts.left).toEqual({ matches: 2, wins: 1 });
      expect(counts.right).toEqual({ matches: 1, wins: 1 });
    });
  });

  it('counts a win for the losing team’s player correctly (winner B, player on B)', async () => {
    db = makeFirestore({
      'matches/m1': match({ winner: 'B' }),
    });

    const counts = await sideStats('b1'); // b1 played left on team B, which won
    expect(counts.left).toEqual({ matches: 1, wins: 1 });
  });

  it('skips matches with no recorded sides — pre-feature history is not guessed at', async () => {
    db = makeFirestore({
      'matches/m1': match({ sides: undefined }),
      'matches/m2': match(),
    });

    const counts = await sideStats('me');
    expect(counts.left.matches).toBe(1);
  });
});
