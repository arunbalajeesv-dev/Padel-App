import { describe, it, expect } from 'vitest';

import {
  tierLabel,
  reliability,
  placementMessage,
  formatScore,
  teamNames,
} from './homeView.js';

describe('placementMessage — never estimate a number', () => {
  it('shows nothing once the player is on the board', () => {
    expect(placementMessage({ status: 'visible', matchesRemaining: null })).toEqual({
      show: false,
      text: '',
    });
  });

  it('shows the EXACT number only in the counting state', () => {
    expect(placementMessage({ status: 'counting', matchesRemaining: 3 })).toEqual({
      show: true,
      text: '3 more matches to appear on the leaderboard',
    });
  });

  it('singularises one match', () => {
    expect(placementMessage({ status: 'counting', matchesRemaining: 1 }).text).toBe(
      '1 more match to appear on the leaderboard',
    );
  });

  it('shows NO number while settling — RD trajectory is not a promise', () => {
    const msg = placementMessage({ status: 'settling', matchesRemaining: null });
    expect(msg.show).toBe(true);
    expect(msg.text).toBe('Your rating is still settling — keep playing.');
    expect(msg.text).not.toMatch(/\d/); // no invented count
  });

  it('falls back to the safe (no-number) copy for anything unexpected', () => {
    expect(placementMessage(undefined).show).toBe(false);
    expect(placementMessage({ status: 'weird' }).text).not.toMatch(/\d/);
  });
});

describe('tier and reliability come from status, never a rating', () => {
  it.each([
    ['established', 'Established', 'High'],
    ['provisional', 'Provisional', 'Medium'],
    ['placement', 'Placement', 'Building'],
  ])('%s -> %s / %s', (status, tier, rel) => {
    expect(tierLabel(status)).toBe(tier);
    expect(reliability(status).label).toBe(rel);
  });

  it('fill increases with tier and stays within 0..1', () => {
    expect(reliability('placement').fill).toBeLessThan(reliability('provisional').fill);
    expect(reliability('provisional').fill).toBeLessThan(reliability('established').fill);
    expect(reliability('established').fill).toBe(1);
  });

  it('degrades safely on an unknown status', () => {
    expect(tierLabel(undefined)).toBe('—');
    expect(reliability(undefined).fill).toBe(0);
  });
});

describe('formatScore', () => {
  it('joins sets as games', () => {
    expect(formatScore([{ teamA: 6, teamB: 2 }, { teamA: 6, teamB: 3 }])).toBe('6-2, 6-3');
  });
  it('handles a three-set match', () => {
    expect(formatScore([{ teamA: 4, teamB: 6 }, { teamA: 7, teamB: 5 }, { teamA: 6, teamB: 4 }])).toBe(
      '4-6, 7-5, 6-4',
    );
  });
  it('is empty for no sets', () => {
    expect(formatScore([])).toBe('');
    expect(formatScore(undefined)).toBe('');
  });
});

describe('teamNames — resolves uids, falls back to the uid', () => {
  it('maps known uids to names', () => {
    expect(teamNames(['me', 'a2'], { me: 'Arjun', a2: 'Karthik' })).toEqual(['Arjun', 'Karthik']);
  });
  it('keeps the uid when a name is missing rather than showing blank', () => {
    expect(teamNames(['me', 'ghost'], { me: 'Arjun' })).toEqual(['Arjun', 'ghost']);
  });
});
