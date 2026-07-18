import { describe, it, expect } from 'vitest';

import {
  GLICKO_CENTER,
  GLICKO_SCALE,
  toMu,
  toPhi,
  toRating,
  toRd,
  g,
  E,
  computeV,
  computeDelta,
  computeOutcomeSum,
  updateVolatility,
  phiStar,
  updatePlayer,
  applyInactivity,
} from '../../src/lib/glicko2.js';

const TAU = 0.5;

/**
 * Glickman prints intermediates rounded to 3-4 decimals and then computes the
 * next step from those rounded values, so exact arithmetic drifts slightly from
 * the printed figures. Tolerances below are sized to that rounding, not chosen
 * to make the tests pass — see the note on each.
 */
function expectNear(actual, expected, tolerance) {
  expect(Math.abs(actual - expected)).toBeLessThan(tolerance);
}

describe('scale conversions', () => {
  it('maps the scale centre to mu 0', () => {
    expect(toMu(GLICKO_CENTER)).toBe(0);
  });

  it('converts rating to mu per the paper', () => {
    expectNear(toMu(1500), 0, 1e-9);
    expectNear(toMu(1400), -0.5756, 1e-4);
    expectNear(toMu(1550), 0.2878, 1e-4);
    expectNear(toMu(1700), 1.1513, 1e-4);
  });

  it('converts RD to phi per the paper', () => {
    expectNear(toPhi(200), 1.1513, 1e-4);
    expectNear(toPhi(30), 0.1727, 1e-4);
    expectNear(toPhi(100), 0.5756, 1e-4);
    expectNear(toPhi(300), 1.7269, 1e-4);
  });

  it('round-trips rating through mu', () => {
    for (const rating of [1000, 1500, 1837.5, 2400]) {
      expectNear(toRating(toMu(rating)), rating, 1e-9);
    }
  });

  it('round-trips RD through phi', () => {
    for (const rd of [30, 50, 200, 350]) {
      expectNear(toRd(toPhi(rd)), rd, 1e-9);
    }
  });

  it('uses the scale factor from the paper', () => {
    expect(GLICKO_SCALE).toBe(173.7178);
  });
});

describe("Glickman's worked example", () => {
  // "Example of the Glicko-2 system": player 1500/200/0.06, tau = 0.5, against
  // 1400/30 (win), 1550/100 (loss), 1700/300 (loss).
  const mu = toMu(1500);
  const phi = toPhi(200);
  const sigma = 0.06;

  const opponents = [
    { mu: toMu(1400), phi: toPhi(30), score: 1 },
    { mu: toMu(1550), phi: toPhi(100), score: 0 },
    { mu: toMu(1700), phi: toPhi(300), score: 0 },
  ];

  it('matches the published g(phi) values', () => {
    expectNear(g(opponents[0].phi), 0.9955, 1e-4);
    expectNear(g(opponents[1].phi), 0.9531, 1e-4);
    expectNear(g(opponents[2].phi), 0.7242, 1e-4);
  });

  it('matches the published E values', () => {
    // The paper prints E to 3 decimals.
    expectNear(E(mu, opponents[0].mu, opponents[0].phi), 0.639, 1e-3);
    expectNear(E(mu, opponents[1].mu, opponents[1].phi), 0.432, 1e-3);
    expectNear(E(mu, opponents[2].mu, opponents[2].phi), 0.303, 1e-3);
  });

  it('matches the published v', () => {
    // Paper: 1.7785, computed from its own rounded E values. Exact: 1.778977.
    expectNear(computeV(mu, opponents), 1.7785, 1e-3);
  });

  it('matches the published delta', () => {
    // Paper: -0.4834. Exact: -0.483933 (same rounding cascade as v).
    const v = computeV(mu, opponents);
    expectNear(computeDelta(mu, opponents, v), -0.4834, 1e-3);
  });

  it('matches the published sigma prime', () => {
    const v = computeV(mu, opponents);
    const delta = computeDelta(mu, opponents, v);

    expectNear(updateVolatility({ phi, sigma, v, delta, tau: TAU }), 0.05999, 1e-4);
  });

  it('matches the published phi star', () => {
    const v = computeV(mu, opponents);
    const delta = computeDelta(mu, opponents, v);
    const newSigma = updateVolatility({ phi, sigma, v, delta, tau: TAU });

    expectNear(phiStar(phi, newSigma), 1.1529, 1e-4);
  });

  it('matches the published phi prime and mu prime', () => {
    const v = computeV(mu, opponents);
    const delta = computeDelta(mu, opponents, v);
    const newSigma = updateVolatility({ phi, sigma, v, delta, tau: TAU });
    const ps = phiStar(phi, newSigma);

    const newPhi = 1 / Math.sqrt(1 / (ps * ps) + 1 / v);
    const newMu = mu + newPhi * newPhi * computeOutcomeSum(mu, opponents);

    expectNear(newPhi, 0.8722, 1e-4);
    expectNear(newMu, -0.2069, 1e-4);
  });

  it('reproduces the published final rating and RD', () => {
    const v = computeV(mu, opponents);
    const delta = computeDelta(mu, opponents, v);
    const newSigma = updateVolatility({ phi, sigma, v, delta, tau: TAU });
    const ps = phiStar(phi, newSigma);
    const newPhi = 1 / Math.sqrt(1 / (ps * ps) + 1 / v);
    const newMu = mu + newPhi * newPhi * computeOutcomeSum(mu, opponents);

    // Paper: 1464.06 / 151.52 / 0.05999. Exact arithmetic gives 1464.0507;
    // the 0.009 gap is the paper's rounded intermediates, not an error here.
    expectNear(toRating(newMu), 1464.06, 0.02);
    expectNear(toRd(newPhi), 151.52, 0.01);
    expectNear(newSigma, 0.05999, 1e-4);
  });
});

describe('g(phi)', () => {
  it('is 1 for a perfectly known opponent', () => {
    expect(g(0)).toBe(1);
  });

  it('shrinks as opponent uncertainty grows', () => {
    expect(g(toPhi(30))).toBeGreaterThan(g(toPhi(200)));
    expect(g(toPhi(200))).toBeGreaterThan(g(toPhi(350)));
  });

  it('stays within (0, 1]', () => {
    for (const rd of [0, 30, 100, 200, 350, 1000]) {
      const value = g(toPhi(rd));
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('E(mu, opponentMu, opponentPhi)', () => {
  it('is 0.5 between equals', () => {
    expect(E(0, 0, toPhi(50))).toBeCloseTo(0.5, 10);
  });

  it('exceeds 0.5 when the player is stronger', () => {
    expect(E(toMu(1700), toMu(1500), toPhi(50))).toBeGreaterThan(0.5);
  });

  it('falls below 0.5 when the player is weaker', () => {
    expect(E(toMu(1300), toMu(1500), toPhi(50))).toBeLessThan(0.5);
  });

  it('is pulled toward 0.5 by opponent uncertainty', () => {
    const confident = E(toMu(1700), toMu(1500), toPhi(30));
    const uncertain = E(toMu(1700), toMu(1500), toPhi(350));

    expect(uncertain).toBeLessThan(confident);
    expect(uncertain).toBeGreaterThan(0.5);
  });

  it('stays within (0, 1)', () => {
    for (const rating of [800, 1200, 1500, 1800, 2400]) {
      const value = E(toMu(rating), toMu(1500), toPhi(50));
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('updatePlayer — one opponent', () => {
  const newPlayer = { mu: toMu(1500), phi: toPhi(350), sigma: 0.06 };
  const veteran = { mu: toMu(1500), phi: toPhi(30), sigma: 0.06 };
  const equalOpponent = { mu: toMu(1500), phi: toPhi(50) };

  it('raises mu on a win and lowers it on a loss', () => {
    const won = updatePlayer(newPlayer, equalOpponent, 1, TAU);
    const lost = updatePlayer(newPlayer, equalOpponent, 0, TAU);

    expect(won.mu).toBeGreaterThan(newPlayer.mu);
    expect(lost.mu).toBeLessThan(newPlayer.mu);
  });

  it('moves a win and a loss symmetrically about the start', () => {
    const won = updatePlayer(newPlayer, equalOpponent, 1, TAU);
    const lost = updatePlayer(newPlayer, equalOpponent, 0, TAU);

    expectNear(won.mu - newPlayer.mu, newPlayer.mu - lost.mu, 1e-9);
  });

  it('reduces phi — a played match is information', () => {
    const after = updatePlayer(newPlayer, equalOpponent, 1, TAU);

    expect(after.phi).toBeLessThan(newPlayer.phi);
  });

  it('moves a maximum-RD new player far more than a minimum-RD veteran', () => {
    const newMove = Math.abs(
      updatePlayer(newPlayer, equalOpponent, 1, TAU).mu - newPlayer.mu,
    );
    const vetMove = Math.abs(
      updatePlayer(veteran, equalOpponent, 1, TAU).mu - veteran.mu,
    );

    expect(newMove).toBeGreaterThan(vetMove * 5);
  });

  it('barely moves a veteran on an expected win', () => {
    const weak = { mu: toMu(1200), phi: toPhi(50) };
    const after = updatePlayer(veteran, weak, 1, TAU);

    expect(toRating(after.mu) - 1500).toBeLessThan(5);
    expect(toRating(after.mu)).toBeGreaterThan(1500);
  });

  it('moves a veteran hard on an upset loss', () => {
    const weak = { mu: toMu(1200), phi: toPhi(50) };
    const expectedWin = updatePlayer(veteran, weak, 1, TAU);
    const upsetLoss = updatePlayer(veteran, weak, 0, TAU);

    const gain = Math.abs(expectedWin.mu - veteran.mu);
    const drop = Math.abs(upsetLoss.mu - veteran.mu);

    expect(drop).toBeGreaterThan(gain * 3);
  });

  it('rewards beating a stronger opponent more than beating a weaker one', () => {
    const strong = { mu: toMu(1900), phi: toPhi(50) };
    const weak = { mu: toMu(1100), phi: toPhi(50) };

    const upsetWin = updatePlayer(veteran, strong, 1, TAU).mu - veteran.mu;
    const routineWin = updatePlayer(veteran, weak, 1, TAU).mu - veteran.mu;

    expect(upsetWin).toBeGreaterThan(routineWin);
  });

  it('raises volatility after a surprising result', () => {
    const strong = { mu: toMu(2100), phi: toPhi(30) };
    const after = updatePlayer(veteran, strong, 1, TAU);

    expect(after.sigma).toBeGreaterThan(veteran.sigma);
  });

  it('keeps volatility positive and finite across extremes', () => {
    const cases = [
      [{ mu: toMu(1500), phi: toPhi(350), sigma: 0.06 }, { mu: toMu(2800), phi: toPhi(30) }, 1],
      [{ mu: toMu(2800), phi: toPhi(30), sigma: 0.06 }, { mu: toMu(800), phi: toPhi(350) }, 0],
      [{ mu: toMu(1500), phi: toPhi(30), sigma: 0.3 }, { mu: toMu(1500), phi: toPhi(30) }, 1],
    ];

    for (const [player, opponent, score] of cases) {
      const after = updatePlayer(player, opponent, score, TAU);

      expect(Number.isFinite(after.sigma)).toBe(true);
      expect(after.sigma).toBeGreaterThan(0);
      expect(Number.isFinite(after.mu)).toBe(true);
      expect(after.phi).toBeGreaterThan(0);
    }
  });

  it('does not mutate its inputs', () => {
    const player = { mu: toMu(1500), phi: toPhi(350), sigma: 0.06 };
    const opponent = { mu: toMu(1500), phi: toPhi(50) };
    const playerBefore = { ...player };
    const opponentBefore = { ...opponent };

    updatePlayer(player, opponent, 1, TAU);

    expect(player).toEqual(playerBefore);
    expect(opponent).toEqual(opponentBefore);
  });

  it('is deterministic', () => {
    const player = { mu: toMu(1500), phi: toPhi(200), sigma: 0.06 };
    const opponent = { mu: toMu(1600), phi: toPhi(80) };

    expect(updatePlayer(player, opponent, 1, TAU)).toEqual(
      updatePlayer(player, opponent, 1, TAU),
    );
  });
});

describe('tau', () => {
  it('damps volatility movement as it shrinks', () => {
    const player = { mu: toMu(1500), phi: toPhi(200), sigma: 0.06 };
    const strong = { mu: toMu(2200), phi: toPhi(30) };

    const loose = updatePlayer(player, strong, 1, 1.2);
    const tight = updatePlayer(player, strong, 1, 0.2);

    expect(Math.abs(loose.sigma - 0.06)).toBeGreaterThan(
      Math.abs(tight.sigma - 0.06),
    );
  });
});

describe('applyInactivity', () => {
  const player = { mu: toMu(1500), phi: toPhi(100), sigma: 0.06 };

  it('grows phi', () => {
    expect(applyInactivity(player).phi).toBeGreaterThan(player.phi);
  });

  it('leaves mu and sigma untouched', () => {
    const after = applyInactivity(player);

    expect(after.mu).toBe(player.mu);
    expect(after.sigma).toBe(player.sigma);
  });

  it('matches sqrt(phi^2 + sigma^2)', () => {
    const expected = Math.sqrt(player.phi ** 2 + player.sigma ** 2);

    expectNear(applyInactivity(player).phi, expected, 1e-12);
  });

  it('compounds across successive idle periods', () => {
    const once = applyInactivity(player);
    const twice = applyInactivity(once);

    expect(twice.phi).toBeGreaterThan(once.phi);
  });

  it('grows a settled veteran RD over a long absence', () => {
    let current = { mu: toMu(1500), phi: toPhi(40), sigma: 0.06 };
    for (let i = 0; i < 52; i += 1) current = applyInactivity(current);

    expect(toRd(current.phi)).toBeGreaterThan(40);
    expect(toRating(current.mu)).toBeCloseTo(1500, 10);
  });

  it('does not mutate its input', () => {
    const before = { ...player };
    applyInactivity(player);

    expect(player).toEqual(before);
  });
});
