import { describe, it, expect, vi, beforeEach } from 'vitest';

import { VALID_CONFIG as CONFIG } from '../fixtures/config.js';
import { makeFirestore } from '../fixtures/fakeFirestore.js';

let db;

vi.mock('../../src/config/firebase.js', () => ({
  getFirestore: () => db,
  getAuth: () => ({}),
}));

const { decayedRd, runDecay } = await import('../../src/jobs/decayRatings.js');

const NOW = Date.parse('2026-07-18T00:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

const user = (id, { rd = 80, lastActiveDays = 0, value = 1500 } = {}) => ({
  name: id,
  gender: 'M',
  rating: { value, rd, sigma: 0.06 },
  status: 'established',
  gamesPlayed: 20,
  lastActiveAt: daysAgo(lastActiveDays),
});

const userDoc = (id) => db.state.get(`users/${id}`);
const historyFor = (id) =>
  [...db.state.entries()]
    .filter(([p]) => p.startsWith(`users/${id}/ratingHistory/`))
    .map(([, d]) => d);

describe('decayedRd — pure', () => {
  it('increases RD for a player below the cap', () => {
    const after = decayedRd({ value: 1500, rd: 80, sigma: 0.06 }, CONFIG);
    expect(after).toBeGreaterThan(80);
  });

  it('never exceeds defaultRd', () => {
    const after = decayedRd({ value: 1500, rd: 349, sigma: 0.06 }, CONFIG);
    expect(after).toBeLessThanOrEqual(CONFIG.defaultRd);
  });

  it('leaves an at-cap player unchanged (capped, not grown past 350)', () => {
    const after = decayedRd({ value: 1500, rd: CONFIG.defaultRd, sigma: 0.06 }, CONFIG);
    expect(after).toBe(CONFIG.defaultRd);
  });

  it('does not depend on the rating value — only RD moves', () => {
    const a = decayedRd({ value: 1200, rd: 80, sigma: 0.06 }, CONFIG);
    const b = decayedRd({ value: 2000, rd: 80, sigma: 0.06 }, CONFIG);
    expect(a).toBe(b);
  });
});

describe('runDecay', () => {
  beforeEach(() => {
    db = makeFirestore({
      'config/rating': CONFIG,
      'users/active': user('active', { lastActiveDays: 3 }),      // recent — safe
      'users/edge': user('edge', { lastActiveDays: 29 }),          // just inside 30d
      'users/stale': user('stale', { lastActiveDays: 60, rd: 80 }), // inactive
      'users/gone': user('gone', { lastActiveDays: 400, rd: 340 }), // long gone, near cap
    });
  });

  it('decays only players past the inactivity threshold', async () => {
    const summary = await runDecay({ config: CONFIG, now: NOW });

    expect(userDoc('active').rating.rd).toBe(80); // untouched
    expect(userDoc('edge').rating.rd).toBe(80); // 29d < 30d, untouched
    expect(userDoc('stale').rating.rd).toBeGreaterThan(80); // decayed
    expect(summary.decayed).toBe(2); // stale + gone
  });

  it('leaves the rating value and lastActiveAt untouched', async () => {
    const before = { ...userDoc('stale') };
    await runDecay({ config: CONFIG, now: NOW });

    expect(userDoc('stale').rating.value).toBe(before.rating.value);
    // Decaying is not activity — resetting the clock would stop future decay.
    expect(userDoc('stale').lastActiveAt).toBe(before.lastActiveAt);
  });

  it('caps RD at defaultRd for a long-absent player', async () => {
    await runDecay({ config: CONFIG, now: NOW });
    expect(userDoc('gone').rating.rd).toBeLessThanOrEqual(CONFIG.defaultRd);
  });

  it('writes an auditable ratingHistory entry per decayed player', async () => {
    await runDecay({ config: CONFIG, now: NOW });

    const entries = historyFor('stale');
    expect(entries).toHaveLength(1);
    const [e] = entries;
    expect(e.reason).toBe('inactivity');
    expect(e.matchId).toBeNull();
    expect(e.ratingBefore).toBe(e.ratingAfter); // rating did not move
    expect(e.rdBefore).toBe(80);
    expect(e.rdAfter).toBe(userDoc('stale').rating.rd);
    expect(e.configVersion).toBe(CONFIG.version);
  });

  it('does not write history for an untouched (recent) player', async () => {
    await runDecay({ config: CONFIG, now: NOW });
    expect(historyFor('active')).toEqual([]);
  });

  it('is safe to run twice — a fully-capped player then no-ops', async () => {
    // Push gone to the cap, then a second run must not write another entry.
    await runDecay({ config: CONFIG, now: NOW });
    db.state.set('users/gone', {
      ...userDoc('gone'),
      rating: { ...userDoc('gone').rating, rd: CONFIG.defaultRd },
    });
    const historyBefore = historyFor('gone').length;

    const summary = await runDecay({ config: CONFIG, now: NOW });

    expect(historyFor('gone').length).toBe(historyBefore); // no new entry
    expect(summary.decayed).toBeLessThan(2);
  });
});
