import { describe, it, expect } from 'vitest';

import { isLegalSet, setHint, checkSets, setsWonByTeam } from './scoreCheck.js';

describe('isLegalSet — mirrors the server endings', () => {
  it.each([[6, 0], [6, 4], [7, 5], [7, 6], [0, 6], [5, 7]])('accepts %i-%i', (a, b) => {
    expect(isLegalSet(a, b)).toBe(true);
  });

  it.each([
    [6, 5], // must win by 2 or reach 7-5/7-6
    [8, 6],
    [7, 4],
    [6, 6], // level
    [0, 0],
    [3, 1], // unfinished
  ])('rejects %i-%i', (a, b) => {
    expect(isLegalSet(a, b)).toBe(false);
  });

  it('rejects non-integers and negatives', () => {
    expect(isLegalSet(6, 4.5)).toBe(false);
    expect(isLegalSet(-1, 6)).toBe(false);
  });
});

describe('setHint — gentle, actionable feedback', () => {
  it('calls a fresh set incomplete, not illegal', () => {
    expect(setHint({ teamA: 0, teamB: 0 })).toMatch(/enter the games/i);
  });
  it('flags a level set', () => {
    expect(setHint({ teamA: 5, teamB: 5 })).toMatch(/can't end level/i);
  });
  it('flags an implausible score with an example', () => {
    expect(setHint({ teamA: 8, teamB: 6 })).toMatch(/not a valid set/i);
  });
  it('is null for a legal set', () => {
    expect(setHint({ teamA: 6, teamB: 4 })).toBeNull();
  });
});

describe('checkSets — readiness and DISPLAY-ONLY format', () => {
  it('is ready for one legal set and labels it a single set', () => {
    const r = checkSets([{ teamA: 6, teamB: 4 }]);
    expect(r.ready).toBe(true);
    expect(r.formatLabel).toBe('Single set');
    expect(r.perSet).toEqual([null]);
  });

  it('labels two or three sets best of three', () => {
    expect(checkSets([{ teamA: 6, teamB: 4 }, { teamA: 6, teamB: 3 }]).formatLabel).toBe('Best of three');
    expect(
      checkSets([{ teamA: 6, teamB: 4 }, { teamA: 3, teamB: 6 }, { teamA: 7, teamB: 5 }]).formatLabel,
    ).toBe('Best of three');
  });

  it('is not ready if any set is implausible', () => {
    const r = checkSets([{ teamA: 6, teamB: 4 }, { teamA: 6, teamB: 6 }]);
    expect(r.ready).toBe(false);
    expect(r.perSet[0]).toBeNull();
    expect(r.perSet[1]).toMatch(/level/i);
  });

  it('is not ready beyond three sets', () => {
    const four = [
      { teamA: 6, teamB: 4 }, { teamA: 6, teamB: 4 },
      { teamA: 6, teamB: 4 }, { teamA: 6, teamB: 4 },
    ];
    expect(checkSets(four).ready).toBe(false);
  });

  it('is not ready with no sets', () => {
    expect(checkSets([]).ready).toBe(false);
  });
});

describe('setsWonByTeam — running summary, never sent', () => {
  it('counts only completed legal sets', () => {
    expect(setsWonByTeam([{ teamA: 6, teamB: 4 }, { teamA: 3, teamB: 6 }, { teamA: 0, teamB: 0 }])).toEqual({
      mine: 1,
      theirs: 1,
    });
  });
});
