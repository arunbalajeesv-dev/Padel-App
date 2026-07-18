import { describe, it, expect } from 'vitest';

import { placementCountdown, PLACEMENT_STATUS } from '../../src/lib/placement.js';

/** Mirrors config/rating v1. */
const CONFIG = {
  rdThresholds: { placement: 150, provisional: 100 },
  gamesPlayedFloors: { provisional: 8, established: 10 },
};

const at = (rd, gamesPlayed) => placementCountdown({ rd, gamesPlayed }, CONFIG);

describe('COUNTING branch — RD clear, only matches remain', () => {
  it('shows an exact number when RD is below the threshold', () => {
    expect(at(140, 2)).toEqual({
      status: PLACEMENT_STATUS.COUNTING,
      matchesRemaining: 6,
    });
  });

  it('counts down exactly against the floor', () => {
    expect(at(140, 0).matchesRemaining).toBe(8);
    expect(at(140, 1).matchesRemaining).toBe(7);
    expect(at(140, 3).matchesRemaining).toBe(5);
    expect(at(140, 7).matchesRemaining).toBe(1);
  });

  it('is arithmetic, not a projection — RD does not affect the number', () => {
    // Any RD below the threshold yields the same count. The number describes the
    // games condition only, which is the whole point.
    for (const rd of [149, 120, 80, 40, 0]) {
      expect(at(rd, 2).matchesRemaining).toBe(6);
    }
  });

  it('reproduces the wireframe copy "3 more matches"', () => {
    // At the floor of 8, a player with 5 games has 3 to go.
    const { status, matchesRemaining } = at(145, 5);

    expect(status).toBe(PLACEMENT_STATUS.COUNTING);
    expect(`${matchesRemaining} more matches to appear on the leaderboard`).toBe(
      '3 more matches to appear on the leaderboard',
    );
  });
});

describe('SETTLING branch — RD outstanding, no number', () => {
  it('shows no number when RD is above the threshold', () => {
    expect(at(200, 2)).toEqual({
      status: PLACEMENT_STATUS.SETTLING,
      matchesRemaining: null,
    });
  });

  it('shows no number even when the games floor is already met', () => {
    // The player has played 12 matches but RD is still 180. We cannot say how
    // many more it will take, so we say nothing.
    expect(at(180, 12)).toEqual({
      status: PLACEMENT_STATUS.SETTLING,
      matchesRemaining: null,
    });
  });

  it('shows no number even when the floor is unmet too', () => {
    // Both conditions outstanding. Showing "3 more matches" would be a lie:
    // playing 3 more would not put them on the leaderboard.
    expect(at(300, 2)).toEqual({
      status: PLACEMENT_STATUS.SETTLING,
      matchesRemaining: null,
    });
  });

  it('never returns a number in this branch, at any RD or games count', () => {
    for (const rd of [150, 160, 200, 260, 350]) {
      for (const games of [0, 3, 5, 9, 20]) {
        expect(at(rd, games).matchesRemaining).toBeNull();
      }
    }
  });
});

describe('VISIBLE branch — both conditions met', () => {
  it('reports visible with no number', () => {
    expect(at(140, 8)).toEqual({
      status: PLACEMENT_STATUS.VISIBLE,
      matchesRemaining: null,
    });
  });

  it('stays visible well past the floor', () => {
    expect(at(60, 40).status).toBe(PLACEMENT_STATUS.VISIBLE);
  });
});

describe('boundaries are strict', () => {
  it('treats exactly the RD threshold as still settling', () => {
    expect(at(150, 2).status).toBe(PLACEMENT_STATUS.SETTLING);
    expect(at(149.999, 2).status).toBe(PLACEMENT_STATUS.COUNTING);
  });

  it('treats exactly the games floor as met', () => {
    expect(at(140, 8).status).toBe(PLACEMENT_STATUS.VISIBLE);
    expect(at(140, 7).status).toBe(PLACEMENT_STATUS.COUNTING);
  });

  it('flips to visible on the exact match that clears the floor', () => {
    expect(at(140, 7)).toEqual({
      status: PLACEMENT_STATUS.COUNTING,
      matchesRemaining: 1,
    });
    expect(at(140, 8).status).toBe(PLACEMENT_STATUS.VISIBLE);
  });
});

describe('the countdown never estimates', () => {
  it('has no branch that returns a number while RD is outstanding', () => {
    // The guarantee, stated as a test: a number appears only when the games
    // floor is the sole remaining condition.
    const grid = [];
    for (const rd of [0, 50, 100, 149, 150, 151, 200, 350]) {
      for (const games of [0, 1, 4, 5, 6, 20]) {
        grid.push([rd, games, at(rd, games)]);
      }
    }

    for (const [rd, games, result] of grid) {
      if (result.matchesRemaining !== null) {
        expect(rd).toBeLessThan(CONFIG.rdThresholds.placement);
        expect(games).toBeLessThan(CONFIG.gamesPlayedFloors.provisional);
        expect(result.status).toBe(PLACEMENT_STATUS.COUNTING);
      }
    }
  });

  it('always returns a positive number when it returns one at all', () => {
    for (const games of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(at(140, games).matchesRemaining).toBeGreaterThan(0);
    }
  });
});

describe('config injection', () => {
  it('uses the injected games floor, not a hardcoded one', () => {
    const raised = {
      ...CONFIG,
      gamesPlayedFloors: { provisional: 12, established: 20 },
    };
    const result = placementCountdown({ rd: 140, gamesPlayed: 2 }, raised);

    expect(result.matchesRemaining).toBe(10);
  });

  it('uses the injected RD threshold, not a hardcoded 150', () => {
    const loosened = { ...CONFIG, rdThresholds: { placement: 250, provisional: 100 } };
    const result = placementCountdown({ rd: 200, gamesPlayed: 2 }, loosened);

    expect(result.status).toBe(PLACEMENT_STATUS.COUNTING);
  });

  it.each([
    ['rdThresholds.placement', { gamesPlayedFloors: { provisional: 5 } }],
    ['gamesPlayedFloors.provisional', { rdThresholds: { placement: 150 } }],
  ])('throws rather than guessing when %s is missing', (name, broken) => {
    expect(() => placementCountdown({ rd: 140, gamesPlayed: 2 }, broken)).toThrow(
      new RegExp(name.replace('.', '\\.')),
    );
  });

  it('throws on a non-numeric player field rather than rendering NaN', () => {
    expect(() => placementCountdown({ rd: '140', gamesPlayed: 2 }, CONFIG)).toThrow(
      /player\.rd/,
    );
    expect(() => placementCountdown({ rd: 140, gamesPlayed: null }, CONFIG)).toThrow(
      /player\.gamesPlayed/,
    );
  });
});

describe('purity', () => {
  it('does not mutate its inputs', () => {
    const player = { rd: 140, gamesPlayed: 2 };
    const before = { ...player };
    const configBefore = structuredClone(CONFIG);

    placementCountdown(player, CONFIG);

    expect(player).toEqual(before);
    expect(CONFIG).toEqual(configBefore);
  });

  it('is deterministic', () => {
    expect(at(140, 2)).toEqual(at(140, 2));
  });
});
