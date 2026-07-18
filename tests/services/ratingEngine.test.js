import { describe, it, expect } from 'vitest';

import { computeRatingUpdate } from '../../src/services/ratingEngine.js';
import { FORMAT } from '../../src/lib/scoreValidator.js';

/** Mirrors config/rating v1 as seeded. */
const CONFIG = {
  version: 1,
  tau: 0.5,
  defaultRating: 1500,
  defaultRd: 350,
  defaultVolatility: 0.06,
  lambdaSame: 0.12,
  lambdaMixed: 0.12,
  gapScaleD: 1.15,
  synergy: {
    same: { repeat: 0.1, firstTime: 0.17 },
    mixed: { repeat: 0.17, firstTime: 0.23 },
  },
  formatSingleSet: 0.65,
  formatThreeSet: 1.0,
  marginBase: 0.8,
  marginCoefficient: 0.4,
  repeatMultipliers: [1.0, 0.7, 0.4, 0.2],
  repeatWindowDays: 7,
  maxDeltaPerMatch: 300,
  rdThresholds: { placement: 150, provisional: 100 },
  gamesPlayedFloors: { provisional: 8, established: 10 },
  displayScale: { ratingAtZero: 1000, ratingAtMax: 2500, maxUnits: 7 },
};

/**
 * Default gamesPlayed is 20 so the default player is established, not in
 * placement — placement players are exempt from the cap, so tests that exercise
 * the cap must use settled players.
 */
const player = (id, rating, rd = 80, gamesPlayed = 20, sigma = 0.06) => ({
  id,
  rating,
  rd,
  sigma,
  gamesPlayed,
});

function match({
  teamA = [player('a1', 1500), player('a2', 1500)],
  teamB = [player('b1', 1500), player('b2', 1500)],
  aMixed = false,
  bMixed = false,
  aRepeatPairing = false,
  bRepeatPairing = false,
  winner = 'A',
  format = FORMAT.THREE_SET,
  gamesA = 12,
  gamesB = 7,
  repeatCount = 0,
  config = CONFIG,
} = {}) {
  return computeRatingUpdate({
    teams: {
      A: { players: teamA, isMixed: aMixed, hasPlayedTogether: aRepeatPairing },
      B: { players: teamB, isMixed: bMixed, hasPlayedTogether: bRepeatPairing },
    },
    score: { winner, format, gamesA, gamesB },
    context: { repeatCount },
    config,
  });
}

const byId = (result, id) => result.players.find((p) => p.id === id);

describe('shape and audit trail', () => {
  it('returns all four players', () => {
    const result = match();

    expect(result.players).toHaveLength(4);
    expect(result.players.map((p) => p.id).sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('stamps the config version that produced the deltas', () => {
    expect(match().configVersion).toBe(1);
  });

  it('records every multiplier applied, so a rating move can be explained', () => {
    const p = byId(match(), 'a1');

    expect(p.multipliers).toEqual({
      responsibility: expect.any(Number),
      format: expect.any(Number),
      margin: expect.any(Number),
      repeat: expect.any(Number),
    });
    expect(p).toHaveProperty('rawDelta');
    expect(p).toHaveProperty('scaledDelta');
    expect(p).toHaveProperty('finalDelta');
    expect(p).toHaveProperty('capped');
  });

  it('records the per-team audit fields', () => {
    const result = match();

    for (const side of ['A', 'B']) {
      expect(result.teams[side]).toHaveProperty('w');
      expect(result.teams[side]).toHaveProperty('weakLink');
    }
  });

  it('reconstructs the final delta from the recorded parts', () => {
    // The audit trail must actually add up.
    const p = byId(match(), 'a1');
    const { responsibility, format, margin, repeat } = p.multipliers;

    expect(p.rawDelta * responsibility * format * margin * repeat).toBeCloseTo(
      p.scaledDelta,
      9,
    );
  });

  it('reports before and after state for each player', () => {
    const p = byId(match(), 'a1');

    expect(p.before).toEqual({ rating: 1500, rd: 80, sigma: 0.06 });
    expect(p.after.rating).toBeCloseTo(1500 + p.finalDelta, 9);
  });
});

describe('winners rise, losers fall', () => {
  it('moves the winning team up and the losing team down', () => {
    const result = match({ winner: 'A' });

    expect(byId(result, 'a1').finalDelta).toBeGreaterThan(0);
    expect(byId(result, 'a2').finalDelta).toBeGreaterThan(0);
    expect(byId(result, 'b1').finalDelta).toBeLessThan(0);
    expect(byId(result, 'b2').finalDelta).toBeLessThan(0);
  });

  it('reduces RD for everyone — a played match is information', () => {
    for (const p of match().players) {
      expect(p.after.rd).toBeLessThan(p.before.rd);
    }
  });
});

describe('a single set counts less than a three-set match', () => {
  it('produces a smaller delta for the same result', () => {
    const single = byId(match({ format: FORMAT.SINGLE, gamesA: 6, gamesB: 4 }), 'a1');
    const threeSet = byId(match({ format: FORMAT.THREE_SET, gamesA: 6, gamesB: 4 }), 'a1');

    expect(Math.abs(single.finalDelta)).toBeLessThan(Math.abs(threeSet.finalDelta));
  });

  it('applies exactly the 0.65 / 1.0 ratio', () => {
    const single = byId(match({ format: FORMAT.SINGLE, gamesA: 6, gamesB: 4 }), 'a1');
    const threeSet = byId(match({ format: FORMAT.THREE_SET, gamesA: 6, gamesB: 4 }), 'a1');

    expect(single.multipliers.format).toBe(0.65);
    expect(threeSet.multipliers.format).toBe(1.0);
    expect(single.finalDelta / threeSet.finalDelta).toBeCloseTo(0.65, 9);
  });

  it('treats a straight-sets 2-0 as a full three-set match, not a discounted one', () => {
    const straightSets = byId(match({ format: FORMAT.THREE_SET }), 'a1');

    expect(straightSets.multipliers.format).toBe(1.0);
  });

  it('rejects an unknown format rather than guessing', () => {
    expect(() => match({ format: 'bestOfFive' })).toThrow(/unknown format/);
  });
});

describe('a blowout counts more than a tight win', () => {
  it('produces a larger delta', () => {
    const blowout = byId(match({ gamesA: 12, gamesB: 0 }), 'a1');
    const tight = byId(match({ gamesA: 14, gamesB: 12 }), 'a1');

    expect(blowout.finalDelta).toBeGreaterThan(tight.finalDelta);
  });

  it('hits the margin ceiling of 1.2 at 6-0 6-0', () => {
    const p = byId(match({ gamesA: 12, gamesB: 0 }), 'a1');

    expect(p.multipliers.margin).toBeCloseTo(1.2, 9);
  });

  it('hits the margin floor of 0.8 when games are level', () => {
    const p = byId(match({ gamesA: 15, gamesB: 15 }), 'a1');

    expect(p.multipliers.margin).toBeCloseTo(0.8, 9);
  });

  it('applies the same margin to all four players', () => {
    const result = match({ gamesA: 12, gamesB: 3 });
    const margins = result.players.map((p) => p.multipliers.margin);

    expect(new Set(margins).size).toBe(1);
  });

  it('is identical whichever team won — a blowout informs both sides equally', () => {
    const aWon = byId(match({ winner: 'A', gamesA: 12, gamesB: 2 }), 'a1');
    const bWon = byId(match({ winner: 'B', gamesA: 2, gamesB: 12 }), 'a1');

    expect(aWon.multipliers.margin).toBeCloseTo(bWon.multipliers.margin, 12);
  });

  it('never produces NaN from the losing side', () => {
    // The losing team's signed ratio would be negative; the absolute ratio
    // cannot be. This is the crash that the match-level decision prevents.
    for (const p of match({ winner: 'B', gamesA: 3, gamesB: 12 }).players) {
      expect(Number.isNaN(p.finalDelta)).toBe(false);
      expect(Number.isFinite(p.finalDelta)).toBe(true);
    }
  });
});

describe('the weak link moves more than the strong partner', () => {
  const teamA = [player('weak', 1300), player('strong', 1700)];

  it('gives the weak link the larger delta', () => {
    const result = match({ teamA });

    expect(Math.abs(byId(result, 'weak').finalDelta)).toBeGreaterThan(
      Math.abs(byId(result, 'strong').finalDelta),
    );
  });

  it('identifies the lower-rated player as the weak link', () => {
    const result = match({ teamA });

    expect(byId(result, 'weak').isWeakLink).toBe(true);
    expect(byId(result, 'strong').isWeakLink).toBe(false);
  });

  it('splits responsibility as 2w and 2(1-w)', () => {
    const result = match({ teamA });
    const w = result.teams.A.w;

    expect(byId(result, 'weak').multipliers.responsibility).toBeCloseTo(2 * w, 12);
    expect(byId(result, 'strong').multipliers.responsibility).toBeCloseTo(2 * (1 - w), 12);
  });

  it('is neutral for both when the pair is level', () => {
    const result = match({ teamA: [player('x', 1500), player('y', 1500)] });

    expect(byId(result, 'x').multipliers.responsibility).toBe(1);
    expect(byId(result, 'y').multipliers.responsibility).toBe(1);
  });

  it('does not let one team\'s pairing type leak into the other', () => {
    // M+F vs M+M — Team A is mixed, Team B is not. Each takes its own lambda.
    const result = match({ aMixed: true, bMixed: false });

    expect(result.teams.A.w).toBeDefined();
    expect(result.teams.B.w).toBeDefined();
  });
});

describe('a repeated matchup counts less', () => {
  it('reduces the delta on a repeat', () => {
    const first = byId(match({ repeatCount: 0 }), 'a1');
    const second = byId(match({ repeatCount: 1 }), 'a1');

    expect(Math.abs(second.finalDelta)).toBeLessThan(Math.abs(first.finalDelta));
  });

  it('walks the diminishing-returns table', () => {
    const deltas = [0, 1, 2, 3].map(
      (repeatCount) => byId(match({ repeatCount }), 'a1').finalDelta,
    );

    for (let i = 1; i < deltas.length; i += 1) {
      expect(deltas[i]).toBeLessThan(deltas[i - 1]);
    }
  });

  it('selects the multiplier by prior occurrences, index 0 being a first meeting', () => {
    expect(byId(match({ repeatCount: 0 }), 'a1').multipliers.repeat).toBe(1.0);
    expect(byId(match({ repeatCount: 1 }), 'a1').multipliers.repeat).toBe(0.7);
    expect(byId(match({ repeatCount: 2 }), 'a1').multipliers.repeat).toBe(0.4);
    expect(byId(match({ repeatCount: 3 }), 'a1').multipliers.repeat).toBe(0.2);
  });

  it('clamps past the end of the table rather than returning undefined', () => {
    expect(byId(match({ repeatCount: 9 }), 'a1').multipliers.repeat).toBe(0.2);
    expect(byId(match({ repeatCount: 500 }), 'a1').multipliers.repeat).toBe(0.2);
  });

  it('rejects a negative or fractional repeat count', () => {
    expect(() => match({ repeatCount: -1 })).toThrow(/non-negative integer/);
    expect(() => match({ repeatCount: 1.5 })).toThrow(/non-negative integer/);
  });
});

describe('placement players are exempt from the cap', () => {
  // RD 350 with 0 games — squarely in placement.
  const newcomer = (id) => player(id, 1500, 350, 0);

  const upset = {
    teamA: [newcomer('new1'), newcomer('new2')],
    teamB: [player('vet1', 2400, 30), player('vet2', 2400, 30)],
    gamesA: 12,
    gamesB: 0,
    winner: 'A',
  };

  it('identifies a high-RD newcomer as being in placement', () => {
    expect(byId(match(upset), 'new1').tier).toBe('placement');
  });

  it('never caps a placement player, however large the delta', () => {
    const p = byId(match(upset), 'new1');

    expect(p.scaledDelta).toBeGreaterThan(CONFIG.maxDeltaPerMatch);
    expect(p.capExempt).toBe(true);
    expect(p.capped).toBe(false);
    expect(p.finalDelta).toBe(p.scaledDelta);
  });

  it('lets an ordinary placement win move the full distance', () => {
    // The original defect: an RD-350 newcomer winning an ordinary 6-4 6-3 scales
    // to ~176. Under the old 150 cap that clamped to 150 while RD still fell to
    // ~252 — leaving the player confident in a rating we refused to let move.
    // 150 is asserted here as the historical value, not as the current cap.
    const OLD_CAP = 150;
    const ordinary = match({
      teamA: [newcomer('n1'), newcomer('n2')],
      teamB: [player('o1', 1500, 80), player('o2', 1500, 80)],
      gamesA: 12,
      gamesB: 7,
    });
    const p = byId(ordinary, 'n1');

    expect(p.tier).toBe('placement');
    expect(p.finalDelta).toBeGreaterThan(OLD_CAP);
    expect(p.capped).toBe(false);
    expect(p.finalDelta).toBe(p.scaledDelta);
  });

  it('is exempt because of tier, not because of RD alone', () => {
    // RD 140 clears the RD bound but 2 games does not clear the floor, so the
    // player is still in placement and still exempt.
    const p = byId(match({ teamA: [player('p', 1500, 140, 2), player('q', 1500, 140, 2)] }), 'p');

    expect(p.tier).toBe('placement');
    expect(p.capExempt).toBe(true);
  });

  it('still exempts a placement player on the losing side', () => {
    const collapse = match({
      teamA: [player('fall1', 2400, 350, 0), player('fall2', 2400, 350, 0)],
      teamB: [player('low1', 1200, 30), player('low2', 1200, 30)],
      winner: 'B',
      gamesA: 0,
      gamesB: 12,
    });
    const p = byId(collapse, 'fall1');

    expect(p.scaledDelta).toBeLessThan(-CONFIG.maxDeltaPerMatch);
    expect(p.finalDelta).toBe(p.scaledDelta);
    expect(p.capped).toBe(false);
  });
});

describe('the per-match cap binds for settled players', () => {
  it('caps a provisional player whose delta exceeds the cap', () => {
    // At the real cap of 150 a provisional player never gets close, which is the
    // point — it is a bug backstop. Inject a low cap to exercise the mechanism.
    const tight = { ...CONFIG, maxDeltaPerMatch: 10 };
    // 9 games: past the floor of 8, short of established's 10.
    const result = match({
      teamA: [player('prov1', 1500, 140, 9), player('prov2', 1500, 140, 9)],
      config: tight,
    });
    const p = byId(result, 'prov1');

    expect(p.tier).toBe('provisional');
    expect(p.capExempt).toBe(false);
    expect(p.capped).toBe(true);
    expect(p.finalDelta).toBe(10);
  });

  it('caps an established player whose delta exceeds the cap', () => {
    const tight = { ...CONFIG, maxDeltaPerMatch: 5 };
    const p = byId(match({ config: tight }), 'a1');

    expect(p.tier).toBe('established');
    expect(p.capped).toBe(true);
    expect(p.finalDelta).toBe(5);
  });

  it('never fires at the real cap for settled players in normal play', () => {
    for (const p of match().players) {
      expect(p.capped).toBe(false);
      expect(Math.abs(p.finalDelta)).toBeLessThan(CONFIG.maxDeltaPerMatch);
    }
  });

  it.each([
    ['lambdaMixed 0.12 (launch)', 0.12],
    ['lambdaMixed 0.20 (if the Step 9 sweep concludes it)', 0.2],
  ])('clears the worst legitimate provisional delta at %s', (_label, lambdaMixed) => {
    // The worst legitimate case: a provisional player at RD 149, partnered to
    // maximise 2r, winning 6-0 6-0. A 1200 partnering a 2000 and beating two
    // 2000s is a real upset the system SHOULD move fully — the cap must not
    // clamp it. Measured: 185.7 at 0.12, 209.7 at 0.20.
    //
    // This is asserted on BOTH branches because the sweep may raise lambdaMixed,
    // and a cap validated on one branch is not validated.
    const result = match({
      teamA: [player('self', 1200, 149, 9), player('mate', 2000, 80, 30)],
      teamB: [player('o1', 2000, 50, 40), player('o2', 2000, 50, 40)],
      aMixed: true,
      winner: 'A',
      gamesA: 12,
      gamesB: 0,
      config: { ...CONFIG, lambdaMixed },
    });
    const p = byId(result, 'self');

    expect(p.tier).toBe('provisional');
    expect(p.capped).toBe(false);
    expect(Math.abs(p.finalDelta)).toBeLessThan(CONFIG.maxDeltaPerMatch);
  });

  it('preserves the uncapped value in scaledDelta for the audit trail', () => {
    const tight = { ...CONFIG, maxDeltaPerMatch: 5 };
    const p = byId(match({ config: tight }), 'a1');

    expect(p.scaledDelta).not.toBe(p.finalDelta);
    expect(p.after.rating).toBeCloseTo(p.before.rating + p.finalDelta, 9);
  });
});

describe('M_format scales RD shrinkage as well as the delta', () => {
  const base = { gamesA: 6, gamesB: 4 };

  it('shrinks RD less for a single set than a three-set match', () => {
    const single = byId(match({ ...base, format: FORMAT.SINGLE }), 'a1');
    const threeSet = byId(match({ ...base, format: FORMAT.THREE_SET }), 'a1');

    // Less confidence bought => higher remaining RD.
    expect(single.after.rd).toBeGreaterThan(threeSet.after.rd);
  });

  it('still shrinks RD — a single set is a fractional observation, not none', () => {
    const single = byId(match({ ...base, format: FORMAT.SINGLE }), 'a1');

    expect(single.after.rd).toBeLessThan(single.before.rd);
  });

  it('leaves the Glicko result untouched at M_format = 1', () => {
    const full = { ...CONFIG, formatSingleSet: 1.0 };
    const single = byId(match({ ...base, format: FORMAT.SINGLE, config: full }), 'a1');
    const threeSet = byId(match({ ...base, format: FORMAT.THREE_SET }), 'a1');

    expect(single.after.rd).toBeCloseTo(threeSet.after.rd, 9);
  });

  it('records informativeness so the audit trail explains RD too', () => {
    expect(byId(match({ format: FORMAT.SINGLE }), 'a1').informativeness).toBeCloseTo(
      0.65,
      9,
    );
    expect(byId(match({ format: FORMAT.THREE_SET }), 'a1').informativeness).toBe(1);
  });
});

describe('M_repeat scales RD shrinkage as well as the delta', () => {
  it('shrinks RD less on a fourth repeat than a first meeting', () => {
    const first = byId(match({ repeatCount: 0 }), 'a1');
    const fourth = byId(match({ repeatCount: 3 }), 'a1');

    expect(fourth.after.rd).toBeGreaterThan(first.after.rd);
  });

  it('shrinks RD monotonically less as repeats accumulate', () => {
    const rds = [0, 1, 2, 3].map((repeatCount) => byId(match({ repeatCount }), 'a1').after.rd);

    for (let i = 1; i < rds.length; i += 1) {
      expect(rds[i]).toBeGreaterThan(rds[i - 1]);
    }
  });

  it('closes the grind-to-established abuse vector', () => {
    // Beating the same opponent repeatedly informs us about one opponent. It
    // must not buy the same confidence as four distinct matchups.
    const grind = byId(match({ repeatCount: 3 }), 'a1');
    const fresh = byId(match({ repeatCount: 0 }), 'a1');

    expect(grind.after.rd - grind.before.rd).toBeGreaterThan(
      fresh.after.rd - fresh.before.rd,
    );
  });

  it('composes with M_format multiplicatively', () => {
    const p = byId(match({ format: FORMAT.SINGLE, repeatCount: 3 }), 'a1');

    expect(p.informativeness).toBeCloseTo(0.65 * 0.2, 9);
  });
});

describe('M_margin and 2r scale the delta only', () => {
  it('leaves RD unchanged across margins', () => {
    const blowout = byId(match({ gamesA: 12, gamesB: 0 }), 'a1');
    const tight = byId(match({ gamesA: 14, gamesB: 12 }), 'a1');

    // Margin says how decisive, not how informative — RD must not move with it.
    expect(blowout.after.rd).toBeCloseTo(tight.after.rd, 6);
  });

  it('leaves RD unaffected by the responsibility split', () => {
    const result = match({ teamA: [player('weak', 1300), player('strong', 1700)] });
    const weak = byId(result, 'weak');
    const strong = byId(result, 'strong');

    // Different 2r, but both saw the same match, so both learn the same amount
    // relative to their own starting RD.
    expect(weak.multipliers.responsibility).not.toBeCloseTo(
      strong.multipliers.responsibility,
      3,
    );
    expect(weak.informativeness).toBe(strong.informativeness);
  });
});

describe('config injection', () => {
  it('throws rather than producing NaN when a constant is missing', () => {
    const { marginBase, ...broken } = CONFIG;

    expect(() => match({ config: broken })).toThrow(/marginBase/);
  });

  it('throws when tau is missing', () => {
    const { tau, ...broken } = CONFIG;

    expect(() => match({ config: broken })).toThrow(/config\.tau/);
  });

  it('rejects a match with no games played', () => {
    expect(() => match({ gamesA: 0, gamesB: 0 })).toThrow(/at least one game/);
  });

  it('rejects an invalid winner', () => {
    expect(() => match({ winner: 'C' })).toThrow(/score\.winner/);
  });

  it('rejects a team without exactly two players', () => {
    expect(() => match({ teamA: [player('only', 1500)] })).toThrow(/exactly two players/);
  });
});

describe('purity', () => {
  it('does not mutate the players, score, or config', () => {
    const teamA = [player('a1', 1500), player('a2', 1600)];
    const teamB = [player('b1', 1550), player('b2', 1450)];
    const before = structuredClone({ teamA, teamB, CONFIG });

    match({ teamA, teamB });

    expect({ teamA, teamB, CONFIG }).toEqual(before);
  });

  it('is deterministic', () => {
    expect(match()).toEqual(match());
  });
});
