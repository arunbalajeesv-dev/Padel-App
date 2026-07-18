/**
 * Doubles team combination — weak-link weighting.
 *
 * Pure functions. Constants arrive via an injected `config` object rather than
 * an import, so tests can supply their own values and so no tuning constant is
 * ever hardcoded here.
 *
 * This is the layer ABOVE glicko2.js. It collapses a pair into a single
 * synthetic entity; glicko2.js then updates each player against the opposing
 * team's entity via `updatePlayer`. Teammates are never opponents to each other.
 *
 * ---------------------------------------------------------------------------
 * `isMixed` IS PER-TEAM, NOT PER-MATCH
 *
 * `isMixed` describes THIS team's two players. It is NOT a property of the
 * match — there is no match-level gender classification in this system at all.
 * The two teams in one match routinely differ: M+F vs M+M means Team A is mixed
 * and Team B is not, and each takes its own lambda. Call this function once per
 * team, with that team's own flag.
 *
 * Deriving a single match-level `isMixed` and passing it for both teams is a
 * bug — Team B would get mixed-pairing targeting because their OPPONENTS were a
 * mixed pair. At launch config (lambdaMixed == lambdaSame) that bug changes no
 * rating anyone can see, so it will not surface on its own. See CLAUDE.md >
 * "pairingType — Per Team".
 * ---------------------------------------------------------------------------
 */

/** Which side of the pair carries the weak link. */
export const WEAK_LINK = Object.freeze({ A: 'A', B: 'B' });

function requireFinite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `teamCombination: config.${path} must be a finite number (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

function selectLambda(config, isMixed) {
  return isMixed
    ? requireFinite(config?.lambdaMixed, 'lambdaMixed')
    : requireFinite(config?.lambdaSame, 'lambdaSame');
}

function selectSynergy(config, isMixed, hasPlayedTogether) {
  const pairing = isMixed ? 'mixed' : 'same';
  const familiarity = hasPlayedTogether ? 'repeat' : 'firstTime';

  return requireFinite(
    config?.synergy?.[pairing]?.[familiarity],
    `synergy.${pairing}.${familiarity}`,
  );
}

/**
 * Collapse two teammates into one synthetic opponent entity.
 *
 * Teammates are ordered by µ alone — the lower µ is the weak link. RD/φ plays no
 * part in the ordering; see CLAUDE.md > Resolved > "Weak/strong ordering".
 *
 * Team µ is a weak-link-weighted blend, never a flat average. Team φ combines
 * both players' variances and adds a synergy term, never an average of RDs.
 *
 * @param {{mu: number, phi: number}} playerA
 * @param {{mu: number, phi: number}} playerB
 * @param {{isMixed: boolean, hasPlayedTogether: boolean}} pairing Describes THIS
 *   team only. `isMixed` is whether these two players are a mixed pair — not the
 *   match's pool. `hasPlayedTogether` is whether these two have partnered before.
 * @param {object} config Tuning constants: lambdaSame, lambdaMixed, gapScaleD,
 *   synergy.{same,mixed}.{repeat,firstTime}.
 * @returns {{mu: number, phi: number, w: number, weakLink: 'A'|'B'}}
 */
export function combineTeam(playerA, playerB, pairing, config) {
  const { isMixed, hasPlayedTogether } = pairing;

  requireFinite(playerA?.mu, 'playerA.mu — passed by caller');
  requireFinite(playerA?.phi, 'playerA.phi — passed by caller');
  requireFinite(playerB?.mu, 'playerB.mu — passed by caller');
  requireFinite(playerB?.phi, 'playerB.phi — passed by caller');

  const lambda = selectLambda(config, isMixed);
  const gapScaleD = requireFinite(config?.gapScaleD, 'gapScaleD');
  const synergy = selectSynergy(config, isMixed, hasPlayedTogether);

  // Order by µ alone. On an exact tie the pair is symmetric — w is 0.5 either
  // way, so the label is arbitrary; A is chosen for determinism.
  const aIsWeak = playerA.mu <= playerB.mu;
  const weak = aIsWeak ? playerA : playerB;
  const strong = aIsWeak ? playerB : playerA;

  const d = Math.abs(strong.mu - weak.mu);
  const w = 0.5 + lambda * Math.tanh(d / gapScaleD);

  const mu = w * weak.mu + (1 - w) * strong.mu;

  // Variance-aware, with synergy. Not an average of the two RDs.
  const phi = Math.sqrt(
    w * w * weak.phi * weak.phi +
      (1 - w) * (1 - w) * strong.phi * strong.phi +
      synergy * synergy,
  );

  return {
    mu,
    phi,
    w,
    weakLink: aIsWeak ? WEAK_LINK.A : WEAK_LINK.B,
  };
}

/**
 * A player's share of responsibility for the team's result.
 *
 * The same `w` that blends the team rating splits the credit afterwards: the
 * weak link carries `w`, the strong link carries `1 − w`. The final delta scales
 * by `2r`, which is neutral (1.0) for both players when the pair is level.
 *
 * @param {number} w The blend weight from combineTeam.
 * @param {boolean} isWeakLink
 * @returns {number} r
 */
export function responsibility(w, isWeakLink) {
  requireFinite(w, 'w — passed by caller');
  return isWeakLink ? w : 1 - w;
}
