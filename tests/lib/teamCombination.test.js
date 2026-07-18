import { describe, it, expect } from 'vitest';

import { combineTeam, responsibility, WEAK_LINK } from '../../src/lib/teamCombination.js';
import { toMu, toPhi, toRating } from '../../src/lib/glicko2.js';

/**
 * Test fixture — NOT the launch config.
 *
 * `lambdaMixed` is 0.20 here deliberately, so the mixed-vs-same mechanism is
 * exercised and the worked example (w ≈ 0.681) is reproducible. Live config
 * launches with lambdaMixed = lambdaSame = 0.12, which makes the two
 * indistinguishable by design — see LAUNCH_CONFIG below and CLAUDE.md.
 *
 * The mechanism must keep working for whatever the Step 9 sweep concludes, so it
 * is tested at a value that separates the branches.
 */
const CONFIG = {
  lambdaSame: 0.12,
  lambdaMixed: 0.2,
  gapScaleD: 1.15,
  synergy: {
    same: { repeat: 0.1, firstTime: 0.17 },
    mixed: { repeat: 0.17, firstTime: 0.23 },
  },
};

/** Mirrors config/rating v1 as actually seeded. */
const LAUNCH_CONFIG = { ...CONFIG, lambdaMixed: 0.12 };

const SAME_FIRST = { isMixed: false, hasPlayedTogether: false };
const SAME_REPEAT = { isMixed: false, hasPlayedTogether: true };
const MIXED_FIRST = { isMixed: true, hasPlayedTogether: false };
const MIXED_REPEAT = { isMixed: true, hasPlayedTogether: true };

const player = (rating, rd = 50) => ({ mu: toMu(rating), phi: toPhi(rd) });

/** Team phi as it would be with no synergy term, for comparison. */
const phiWithoutSynergy = (w, weakPhi, strongPhi) =>
  Math.sqrt(w * w * weakPhi * weakPhi + (1 - w) * (1 - w) * strongPhi * strongPhi);

describe('worked example — man 1700 with woman 1400, mixed pair', () => {
  const man = player(1700);
  const woman = player(1400);
  const team = combineTeam(man, woman, MIXED_FIRST, CONFIG);

  it('gives w of about 0.681', () => {
    expect(team.w).toBeCloseTo(0.681, 3);
  });

  it('gives a team rating of about 1496 display', () => {
    expect(toRating(team.mu)).toBeCloseTo(1496, 0);
  });

  it('gives responsibility multipliers of about 1.36 and 0.64', () => {
    const rWeak = responsibility(team.w, true);
    const rStrong = responsibility(team.w, false);

    expect(2 * rWeak).toBeCloseTo(1.36, 2);
    expect(2 * rStrong).toBeCloseTo(0.64, 2);
  });

  it('identifies the 1400 player as the weak link', () => {
    // woman is argument B here.
    expect(team.weakLink).toBe(WEAK_LINK.B);
  });

  it('pulls the team well below the plain average of 1550', () => {
    expect(toRating(team.mu)).toBeLessThan(1550);
    expect(1550 - toRating(team.mu)).toBeGreaterThan(50);
  });

  it('is unaffected by argument order', () => {
    const reversed = combineTeam(woman, man, MIXED_FIRST, CONFIG);

    expect(reversed.w).toBeCloseTo(team.w, 12);
    expect(reversed.mu).toBeCloseTo(team.mu, 12);
    expect(reversed.phi).toBeCloseTo(team.phi, 12);
    expect(reversed.weakLink).toBe(WEAK_LINK.A);
  });
});

describe('equal players', () => {
  it('gives w of exactly 0.5', () => {
    const team = combineTeam(player(1500), player(1500), SAME_FIRST, CONFIG);

    expect(team.w).toBe(0.5);
  });

  it('gives a team mu equal to the plain average', () => {
    const a = player(1600);
    const b = player(1600);
    const team = combineTeam(a, b, SAME_FIRST, CONFIG);

    expect(team.mu).toBeCloseTo((a.mu + b.mu) / 2, 12);
    expect(toRating(team.mu)).toBeCloseTo(1600, 9);
  });

  it('gives w of exactly 0.5 for a mixed pair too', () => {
    expect(combineTeam(player(1500), player(1500), MIXED_FIRST, CONFIG).w).toBe(0.5);
  });

  it('makes responsibility neutral for both players', () => {
    const { w } = combineTeam(player(1500), player(1500), SAME_FIRST, CONFIG);

    expect(2 * responsibility(w, true)).toBe(1);
    expect(2 * responsibility(w, false)).toBe(1);
  });

  it('picks a deterministic weak link on an exact tie', () => {
    const team = combineTeam(player(1500), player(1500), SAME_FIRST, CONFIG);

    expect(team.weakLink).toBe(WEAK_LINK.A);
  });
});

describe('w grows with the gap', () => {
  it('increases monotonically as the gap widens', () => {
    const gaps = [1500, 1550, 1600, 1700, 1800, 2000, 2400];
    const ws = gaps.map((r) => combineTeam(player(1500), player(r), SAME_FIRST, CONFIG).w);

    for (let i = 1; i < ws.length; i += 1) {
      expect(ws[i]).toBeGreaterThan(ws[i - 1]);
    }
  });

  it('never exceeds 0.5 + lambda, even at an absurd gap', () => {
    for (const rating of [1600, 2000, 3000, 10_000]) {
      const same = combineTeam(player(1500), player(rating), SAME_FIRST, CONFIG);
      const mixed = combineTeam(player(1500), player(rating), MIXED_FIRST, CONFIG);

      expect(same.w).toBeLessThanOrEqual(0.5 + CONFIG.lambdaSame);
      expect(mixed.w).toBeLessThanOrEqual(0.5 + CONFIG.lambdaMixed);
    }
  });

  it('stays strictly below the ceiling at any realistic gap', () => {
    // tanh < 1 mathematically, so w < 0.5 + lambda in exact arithmetic. The
    // widest plausible gap in a ~100-player club is well inside this.
    const widest = combineTeam(player(1000), player(2400), MIXED_FIRST, CONFIG);

    expect(widest.w).toBeLessThan(0.5 + CONFIG.lambdaMixed);
  });

  it('is never below 0.5 — the weak link always carries at least half', () => {
    for (const rating of [1000, 1400, 1500, 1600, 2200]) {
      const team = combineTeam(player(1500), player(rating), SAME_FIRST, CONFIG);

      expect(team.w).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('saturates at exactly the ceiling only past any reachable gap', () => {
    // Math.tanh returns exactly 1.0 for arguments above ~19.1, which needs a
    // display gap of ~3808 points at D = 1.15. w then equals 0.5 + lambda
    // exactly. This is float64 saturation, not a modelling decision, and it is
    // unreachable in a real club — recorded so it is not mistaken for a bug.
    const absurd = combineTeam(player(1500), player(100_000), MIXED_FIRST, CONFIG);

    expect(absurd.w).toBe(0.7);
    expect(absurd.w).toBeLessThanOrEqual(0.5 + CONFIG.lambdaMixed);
  });
});

describe('mixed pairs tilt further than same-gender pairs', () => {
  it('produces a larger w at the same gap', () => {
    const same = combineTeam(player(1400), player(1700), SAME_FIRST, CONFIG);
    const mixed = combineTeam(player(1400), player(1700), MIXED_FIRST, CONFIG);

    expect(mixed.w).toBeGreaterThan(same.w);
  });

  it('holds across every gap', () => {
    for (const rating of [1550, 1600, 1800, 2100]) {
      const same = combineTeam(player(1500), player(rating), SAME_FIRST, CONFIG);
      const mixed = combineTeam(player(1500), player(rating), MIXED_FIRST, CONFIG);

      expect(mixed.w).toBeGreaterThan(same.w);
    }
  });

  it('pulls the mixed team rating lower than the same-gender equivalent', () => {
    const same = combineTeam(player(1400), player(1700), SAME_FIRST, CONFIG);
    const mixed = combineTeam(player(1400), player(1700), MIXED_FIRST, CONFIG);

    expect(toRating(mixed.mu)).toBeLessThan(toRating(same.mu));
  });

  it('collapses to no difference when the players are level', () => {
    const same = combineTeam(player(1500), player(1500), SAME_FIRST, CONFIG);
    const mixed = combineTeam(player(1500), player(1500), MIXED_FIRST, CONFIG);

    expect(mixed.w).toBe(same.w);
  });
});

describe('isMixed is per-team, not per-match', () => {
  // M+F vs M+M: Team A is a mixed pairing, Team B is not. Each team takes its
  // own lambda. Deriving one match-level flag and applying it to both is the
  // bug this guards; at launch config it changes no visible rating.
  // See CLAUDE.md > "pairingType — Per Team".
  const teamA = [player(1400), player(1700)]; // M+F
  const teamB = [player(1400), player(1700)]; // M+M, same ratings

  it('gives the two teams different w when their pairing types differ', () => {
    const a = combineTeam(...teamA, MIXED_FIRST, CONFIG);
    const b = combineTeam(...teamB, SAME_FIRST, CONFIG);

    expect(a.w).not.toBe(b.w);
    expect(a.w).toBeGreaterThan(b.w);
  });

  it('does not let one team\'s pairing type leak into the other', () => {
    // Team B computed correctly (same-gender) must be unaffected by Team A being
    // mixed — combineTeam sees only its own team, so this is structural.
    const bAlone = combineTeam(...teamB, SAME_FIRST, CONFIG);
    const bInMixedMatch = combineTeam(...teamB, SAME_FIRST, CONFIG);

    expect(bInMixedMatch).toEqual(bAlone);
  });

  it('shows what the conflation bug would cost at fixture lambda', () => {
    const correct = combineTeam(...teamB, SAME_FIRST, CONFIG);
    const buggy = combineTeam(...teamB, MIXED_FIRST, CONFIG); // opponents' flag

    expect(buggy.w).not.toBeCloseTo(correct.w, 3);
  });

  it('shows the same bug is nearly silent at launch config', () => {
    // The point of the auditability requirement: at lambdaMixed == lambdaSame
    // the wrong flag produces an IDENTICAL w, so ratings cannot reveal it.
    const correct = combineTeam(...teamB, SAME_FIRST, LAUNCH_CONFIG);
    const buggy = combineTeam(...teamB, MIXED_FIRST, LAUNCH_CONFIG);

    expect(buggy.w).toBe(correct.w);
    expect(buggy.mu).toBe(correct.mu);
    // Only phi differs, via synergy — and only slightly.
    expect(buggy.phi).not.toBe(correct.phi);
    expect(Math.abs(buggy.phi - correct.phi)).toBeLessThan(0.05);
  });
});

describe('launch config — lambdaMixed equals lambdaSame', () => {
  const a = player(1400);
  const b = player(1700);

  it('gives mixed and same-gender pairs an identical w', () => {
    const same = combineTeam(a, b, SAME_FIRST, LAUNCH_CONFIG);
    const mixed = combineTeam(a, b, MIXED_FIRST, LAUNCH_CONFIG);

    expect(mixed.w).toBe(same.w);
  });

  it('gives them an identical team rating', () => {
    const same = combineTeam(a, b, SAME_FIRST, LAUNCH_CONFIG);
    const mixed = combineTeam(a, b, MIXED_FIRST, LAUNCH_CONFIG);

    expect(mixed.mu).toBe(same.mu);
  });

  it('gives them an identical credit split', () => {
    const same = combineTeam(a, b, SAME_FIRST, LAUNCH_CONFIG);
    const mixed = combineTeam(a, b, MIXED_FIRST, LAUNCH_CONFIG);

    expect(responsibility(mixed.w, true)).toBe(responsibility(same.w, true));
    expect(responsibility(mixed.w, false)).toBe(responsibility(same.w, false));
  });

  it('still differs on team phi — synergy branches on gender, lambda no longer does', () => {
    // Documents the limit of the launch decision: equalising lambda removes
    // gender from w / rating / credit, but NOT from uncertainty. See CLAUDE.md.
    const same = combineTeam(a, b, SAME_FIRST, LAUNCH_CONFIG);
    const mixed = combineTeam(a, b, MIXED_FIRST, LAUNCH_CONFIG);

    expect(mixed.phi).toBeGreaterThan(same.phi);
  });

  it('holds across every gap', () => {
    for (const rating of [1500, 1600, 1900, 2400]) {
      const same = combineTeam(player(1500), player(rating), SAME_FIRST, LAUNCH_CONFIG);
      const mixed = combineTeam(player(1500), player(rating), MIXED_FIRST, LAUNCH_CONFIG);

      expect(mixed.w).toBe(same.w);
    }
  });
});

describe('team phi', () => {
  it('always exceeds the same combination without the synergy term', () => {
    const cases = [
      [player(1500, 50), player(1500, 50), SAME_FIRST],
      [player(1400, 350), player(1700, 30), MIXED_FIRST],
      [player(1200, 100), player(2000, 200), SAME_REPEAT],
      [player(1600, 80), player(1610, 80), MIXED_REPEAT],
    ];

    for (const [a, b, pairing] of cases) {
      const team = combineTeam(a, b, pairing, CONFIG);
      const weak = a.mu <= b.mu ? a : b;
      const strong = a.mu <= b.mu ? b : a;
      const bare = phiWithoutSynergy(team.w, weak.phi, strong.phi);

      expect(team.phi).toBeGreaterThan(bare);
    }
  });

  it('matches the closed form exactly', () => {
    const a = player(1400, 350);
    const b = player(1700, 30);
    const team = combineTeam(a, b, MIXED_FIRST, CONFIG);

    const expected = Math.sqrt(
      team.w ** 2 * a.phi ** 2 +
        (1 - team.w) ** 2 * b.phi ** 2 +
        CONFIG.synergy.mixed.firstTime ** 2,
    );

    expect(team.phi).toBeCloseTo(expected, 12);
  });

  it('is never a plain average of the two RDs', () => {
    const a = player(1500, 350);
    const b = player(1500, 30);
    const team = combineTeam(a, b, SAME_FIRST, CONFIG);

    expect(team.phi).not.toBeCloseTo((a.phi + b.phi) / 2, 4);
  });

  it('is larger for a first-time pairing than a repeat pairing', () => {
    const a = player(1400);
    const b = player(1700);

    expect(combineTeam(a, b, SAME_FIRST, CONFIG).phi).toBeGreaterThan(
      combineTeam(a, b, SAME_REPEAT, CONFIG).phi,
    );
    expect(combineTeam(a, b, MIXED_FIRST, CONFIG).phi).toBeGreaterThan(
      combineTeam(a, b, MIXED_REPEAT, CONFIG).phi,
    );
  });

  it('is larger for a mixed pairing than a same-gender pairing at equal familiarity', () => {
    const a = player(1400);
    const b = player(1700);

    // Same w would confound this, so compare only the synergy contribution:
    // mixed.firstTime (0.23) > same.firstTime (0.17).
    expect(CONFIG.synergy.mixed.firstTime).toBeGreaterThan(CONFIG.synergy.same.firstTime);
    expect(CONFIG.synergy.mixed.repeat).toBeGreaterThan(CONFIG.synergy.same.repeat);
    expect(combineTeam(a, b, MIXED_REPEAT, CONFIG).phi).toBeGreaterThan(
      combineTeam(a, b, SAME_REPEAT, CONFIG).phi,
    );
  });

  it('selects the right synergy value for each of the four combinations', () => {
    const a = player(1500, 50);
    const b = player(1500, 50);

    // At w = 0.5 with equal phi, team phi^2 = 0.5*phi^2 + synergy^2, so the
    // synergy value is recoverable exactly.
    const recover = (pairing) => {
      const team = combineTeam(a, b, pairing, CONFIG);
      return Math.sqrt(team.phi ** 2 - 0.5 * a.phi ** 2);
    };

    expect(recover(SAME_REPEAT)).toBeCloseTo(0.1, 9);
    expect(recover(SAME_FIRST)).toBeCloseTo(0.17, 9);
    expect(recover(MIXED_REPEAT)).toBeCloseTo(0.17, 9);
    expect(recover(MIXED_FIRST)).toBeCloseTo(0.23, 9);
  });
});

describe('weak link identification', () => {
  it('names the lower-mu player regardless of position', () => {
    expect(combineTeam(player(1400), player(1700), SAME_FIRST, CONFIG).weakLink).toBe('A');
    expect(combineTeam(player(1700), player(1400), SAME_FIRST, CONFIG).weakLink).toBe('B');
  });

  it('ignores phi entirely — a high-RD newcomer is not the weak link by construction', () => {
    // Newcomer at 1800 ± 350 paired with an established 1500 ± 30. Ordering is
    // by mu alone, so the 1500 is the weak link despite being far more certain.
    const newcomer = player(1800, 350);
    const established = player(1500, 30);
    const team = combineTeam(newcomer, established, SAME_FIRST, CONFIG);

    expect(team.weakLink).toBe(WEAK_LINK.B);
  });

  it('does not flip when only phi changes', () => {
    const base = combineTeam(player(1400, 30), player(1700, 30), SAME_FIRST, CONFIG);
    const flipped = combineTeam(player(1400, 350), player(1700, 30), SAME_FIRST, CONFIG);

    expect(flipped.weakLink).toBe(base.weakLink);
    expect(flipped.w).toBeCloseTo(base.w, 12);
  });
});

describe('responsibility', () => {
  it('returns w for the weak link and 1 - w for the strong link', () => {
    const { w } = combineTeam(player(1400), player(1700), MIXED_FIRST, CONFIG);

    expect(responsibility(w, true)).toBe(w);
    expect(responsibility(w, false)).toBe(1 - w);
  });

  it('always sums to 1 across the pair', () => {
    for (const rating of [1500, 1600, 1900, 2400]) {
      const { w } = combineTeam(player(1500), player(rating), MIXED_FIRST, CONFIG);

      expect(responsibility(w, true) + responsibility(w, false)).toBeCloseTo(1, 12);
    }
  });

  it('gives the weak link the larger share whenever there is a gap', () => {
    const { w } = combineTeam(player(1400), player(1700), SAME_FIRST, CONFIG);

    expect(responsibility(w, true)).toBeGreaterThan(responsibility(w, false));
  });

  it('caps the 2r multiplier within the range lambda allows', () => {
    const { w } = combineTeam(player(1500), player(100_000), MIXED_FIRST, CONFIG);

    // Mixed lambda 0.20 => w <= 0.70 => 2r_weak <= 1.40, 2r_strong >= 0.60.
    expect(2 * responsibility(w, true)).toBeLessThanOrEqual(1.4);
    expect(2 * responsibility(w, false)).toBeGreaterThanOrEqual(0.6);
  });

  it('keeps 2r inside lambda bounds at a realistic club-wide gap', () => {
    const { w } = combineTeam(player(1000), player(2400), MIXED_FIRST, CONFIG);

    expect(2 * responsibility(w, true)).toBeLessThan(1.4);
    expect(2 * responsibility(w, false)).toBeGreaterThan(0.6);
  });
});

describe('config injection', () => {
  it('uses the injected lambda, not a hardcoded one', () => {
    const doubled = { ...CONFIG, lambdaSame: 0.24 };
    const base = combineTeam(player(1400), player(1700), SAME_FIRST, CONFIG);
    const tuned = combineTeam(player(1400), player(1700), SAME_FIRST, doubled);

    expect(tuned.w - 0.5).toBeCloseTo(2 * (base.w - 0.5), 12);
  });

  it('uses the injected gapScaleD, not a hardcoded one', () => {
    const wider = { ...CONFIG, gapScaleD: 2.3 };
    const base = combineTeam(player(1400), player(1700), SAME_FIRST, CONFIG);
    const tuned = combineTeam(player(1400), player(1700), SAME_FIRST, wider);

    expect(tuned.w).toBeLessThan(base.w);
  });

  it('uses the injected synergy, not a hardcoded one', () => {
    const noSynergy = { ...CONFIG, synergy: { same: { repeat: 0, firstTime: 0 }, mixed: { repeat: 0, firstTime: 0 } } };
    const team = combineTeam(player(1500, 50), player(1500, 50), SAME_FIRST, noSynergy);
    const bare = phiWithoutSynergy(team.w, toPhi(50), toPhi(50));

    expect(team.phi).toBeCloseTo(bare, 12);
  });

  it.each([
    ['lambdaSame', { ...CONFIG, lambdaSame: undefined }, SAME_FIRST],
    ['lambdaMixed', { ...CONFIG, lambdaMixed: undefined }, MIXED_FIRST],
    ['gapScaleD', { ...CONFIG, gapScaleD: undefined }, SAME_FIRST],
  ])('throws rather than producing NaN when %s is missing', (name, broken, pairing) => {
    expect(() => combineTeam(player(1400), player(1700), pairing, broken)).toThrow(
      new RegExp(name),
    );
  });

  it('throws when the synergy branch in use is missing', () => {
    const broken = { ...CONFIG, synergy: { same: { repeat: 0.1 }, mixed: {} } };

    expect(() => combineTeam(player(1400), player(1700), SAME_FIRST, broken)).toThrow(
      /synergy\.same\.firstTime/,
    );
  });

  it('throws on a NaN constant rather than poisoning every delta downstream', () => {
    const broken = { ...CONFIG, lambdaSame: NaN };

    expect(() => combineTeam(player(1400), player(1700), SAME_FIRST, broken)).toThrow(
      /lambdaSame/,
    );
  });
});

describe('purity', () => {
  it('does not mutate its inputs', () => {
    const a = player(1400, 350);
    const b = player(1700, 30);
    const aBefore = { ...a };
    const bBefore = { ...b };
    const configBefore = structuredClone(CONFIG);

    combineTeam(a, b, MIXED_FIRST, CONFIG);

    expect(a).toEqual(aBefore);
    expect(b).toEqual(bBefore);
    expect(CONFIG).toEqual(configBefore);
  });

  it('is deterministic', () => {
    const a = player(1400);
    const b = player(1700);

    expect(combineTeam(a, b, MIXED_FIRST, CONFIG)).toEqual(
      combineTeam(a, b, MIXED_FIRST, CONFIG),
    );
  });
});
