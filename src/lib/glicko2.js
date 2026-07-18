/**
 * Glicko-2, implemented from Mark Glickman's published specification:
 * "Example of the Glicko-2 system" (glicko.net/glicko/glicko2.pdf).
 *
 * Pure functions only — no database, no HTTP, no config reads. `tau` is passed
 * in by the caller, which sources it from config/rating.
 *
 * This layer knows nothing about doubles. It updates one player against ONE
 * opponent. The doubles adaptation — collapsing the opposing pair into a single
 * synthetic opponent, and splitting the resulting delta by responsibility —
 * sits ABOVE this layer. Do not add team logic here.
 *
 * ---------------------------------------------------------------------------
 * ON THE ARRAY-SHAPED PRIMITIVES
 *
 * `computeV`, `computeDelta`, and `computeOutcomeSum` take an ARRAY of
 * opponents. They exist for exactly one reason: Glickman's worked example runs
 * three opponents in a single rating period, and reproducing his published
 * numbers is the canonical correctness check for this file. The array shape is
 * a test affordance, not an API.
 *
 * **The doubles layer must only ever call `updatePlayer`**, which takes a single
 * opponent. Do not pass multiple opponents to the primitives from production
 * code, and do not build a multi-opponent update on top of them. Each of the
 * four players is updated individually against the opposing team collapsed into
 * ONE synthetic opponent entity — teammates are never opponents to each other,
 * and a rating period here is a single match, not a batch of them.
 * ---------------------------------------------------------------------------
 */

/**
 * Glicko-2 scale anchor. This is the fixed centre of the internal scale as
 * defined by the paper, not a tunable constant. It coincides with
 * `config.defaultRating` today, but the two are independent: changing where new
 * players start must not move the scale everyone is already measured on.
 */
export const GLICKO_CENTER = 1500;

/** Glicko-2 scale factor from the paper. */
export const GLICKO_SCALE = 173.7178;

/** Convergence tolerance for the volatility iteration (paper: ε = 0.000001). */
const EPSILON = 0.000001;

/** Guard against a pathological volatility search failing to terminate. */
const MAX_ITERATIONS = 100;

// ---------------------------------------------------------------------------
// Scale conversions
// ---------------------------------------------------------------------------

/** Display rating → internal µ. */
export function toMu(rating) {
  return (rating - GLICKO_CENTER) / GLICKO_SCALE;
}

/** Display RD → internal φ. */
export function toPhi(rd) {
  return rd / GLICKO_SCALE;
}

/** Internal µ → display rating. */
export function toRating(mu) {
  return mu * GLICKO_SCALE + GLICKO_CENTER;
}

/** Internal φ → display RD. */
export function toRd(phi) {
  return phi * GLICKO_SCALE;
}

// ---------------------------------------------------------------------------
// Core quantities
// ---------------------------------------------------------------------------

/**
 * g(φ) — how much an opponent's uncertainty damps the weight of a result.
 * Step 3 of the paper.
 */
export function g(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/**
 * E(µ, µ_j, φ_j) — expected score against one opponent. Step 3 of the paper.
 */
export function E(mu, opponentMu, opponentPhi) {
  return 1 / (1 + Math.exp(-g(opponentPhi) * (mu - opponentMu)));
}

/**
 * v — estimated variance of the player's rating based only on game outcomes.
 * Step 3 of the paper.
 *
 * @param {number} mu
 * @param {Array<{mu: number, phi: number}>} opponents
 * @returns {number}
 */
export function computeV(mu, opponents) {
  const sum = opponents.reduce((acc, opp) => {
    const gj = g(opp.phi);
    const ej = E(mu, opp.mu, opp.phi);
    return acc + gj * gj * ej * (1 - ej);
  }, 0);

  return 1 / sum;
}

/**
 * The outcome-weighted sum Σ g(φ_j)(s_j − E_j). Shared by Δ and by the final µ'.
 *
 * @param {number} mu
 * @param {Array<{mu: number, phi: number, score: number}>} opponents
 * @returns {number}
 */
export function computeOutcomeSum(mu, opponents) {
  return opponents.reduce(
    (acc, opp) => acc + g(opp.phi) * (opp.score - E(mu, opp.mu, opp.phi)),
    0,
  );
}

/**
 * Δ — the estimated improvement in rating, in internal units. Step 4.
 *
 * @param {number} mu
 * @param {Array<{mu: number, phi: number, score: number}>} opponents
 * @param {number} v
 * @returns {number}
 */
export function computeDelta(mu, opponents, v) {
  return v * computeOutcomeSum(mu, opponents);
}

/**
 * σ' — the new volatility, found by the Illinois variant of regula falsi.
 * Step 5 of the paper, followed exactly.
 *
 * @param {{phi: number, sigma: number, v: number, delta: number, tau: number}} params
 * @returns {number}
 */
export function updateVolatility({ phi, sigma, v, delta, tau }) {
  const phiSq = phi * phi;
  const deltaSq = delta * delta;
  const a = Math.log(sigma * sigma);

  const f = (x) => {
    const ex = Math.exp(x);
    const denom = phiSq + v + ex;
    return (
      (ex * (deltaSq - phiSq - v - ex)) / (2 * denom * denom) - (x - a) / (tau * tau)
    );
  };

  // Step 5.2 — bracket the root.
  let A = a;
  let B;

  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      k += 1;
      if (k > MAX_ITERATIONS) {
        throw new Error('Glicko-2 volatility bracketing failed to converge.');
      }
    }
    B = a - k * tau;
  }

  // Step 5.3–5.4 — Illinois iteration.
  let fA = f(A);
  let fB = f(B);
  let iterations = 0;

  while (Math.abs(B - A) > EPSILON) {
    if (++iterations > MAX_ITERATIONS) {
      throw new Error('Glicko-2 volatility iteration failed to converge.');
    }

    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);

    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }

    B = C;
    fB = fC;
  }

  // Step 5.5
  return Math.exp(A / 2);
}

/**
 * φ* — the pre-rating-period RD, inflated by volatility. Step 6 of the paper.
 */
export function phiStar(phi, sigma) {
  return Math.sqrt(phi * phi + sigma * sigma);
}

// ---------------------------------------------------------------------------
// Public update
// ---------------------------------------------------------------------------

/**
 * Update one player against exactly ONE opponent.
 *
 * For doubles, the caller collapses the opposing pair into a single synthetic
 * opponent and passes it here. That collapsing — and the responsibility split
 * applied to the resulting delta — is the layer above's job, not this one's.
 *
 * @param {{mu: number, phi: number, sigma: number}} player
 * @param {{mu: number, phi: number}} opponent
 * @param {number} score 1 for a win, 0 for a loss.
 * @param {number} tau System constant, from config/rating.
 * @returns {{mu: number, phi: number, sigma: number}} internal-scale values.
 */
export function updatePlayer(player, opponent, score, tau) {
  const { mu, phi, sigma } = player;
  const opponents = [{ mu: opponent.mu, phi: opponent.phi, score }];

  const v = computeV(mu, opponents);
  const delta = computeDelta(mu, opponents, v);

  const newSigma = updateVolatility({ phi, sigma, v, delta, tau });
  const newPhiStar = phiStar(phi, newSigma);

  // Step 7
  const newPhi = 1 / Math.sqrt(1 / (newPhiStar * newPhiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * computeOutcomeSum(mu, opponents);

  return { mu: newMu, phi: newPhi, sigma: newSigma };
}

/**
 * Apply a rating period in which the player did not compete.
 *
 * Rating and volatility are unchanged; only φ grows, reflecting that we are less
 * certain about someone we have not seen play. This is the primitive the
 * inactivity decay job builds on.
 *
 * @param {{mu: number, phi: number, sigma: number}} player
 * @returns {{mu: number, phi: number, sigma: number}}
 */
export function applyInactivity(player) {
  return {
    mu: player.mu,
    phi: phiStar(player.phi, player.sigma),
    sigma: player.sigma,
  };
}
