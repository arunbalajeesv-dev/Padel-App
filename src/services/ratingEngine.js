/**
 * The rating pipeline — the doubles adaptation, assembled.
 *
 * PURE. No database reads, no writes, no config lookup. The caller supplies
 * everything (including the config object) and persists the result. This is a
 * service by location only; it takes values in and returns values out, so it is
 * unit-testable without Firestore.
 *
 * Scale: players arrive and leave in DISPLAY scale (rating, rd). The Glicko-2
 * math runs in internal scale; conversion happens here. `maxDeltaPerMatch` is a
 * display-scale number, so the cap is applied in display points.
 *
 * The returned object records the raw delta and EVERY multiplier applied, so the
 * admin console and the audit trail can explain exactly why a rating moved.
 *
 * ---------------------------------------------------------------------------
 * RATING AND CONFIDENCE MOVE TOGETHER
 *
 * Any multiplier that expresses HOW INFORMATIVE a match was must scale BOTH the
 * rating delta and the RD shrinkage. Multipliers that express DIRECTION or
 * CREDIT ALLOCATION scale the delta only.
 *
 *   informativeness -> delta AND rd :  M_format, M_repeat
 *   direction / credit -> delta only:  M_margin, 2r
 *
 * Scaling one but not the other leaves a player confident in a rating we refused
 * to let move. See CLAUDE.md > "Rating and Confidence Move Together".
 * ---------------------------------------------------------------------------
 */
import {
  toMu,
  toPhi,
  toRd,
  updatePlayer,
  phiStar,
  GLICKO_SCALE,
} from '../lib/glicko2.js';
import { combineTeam, responsibility } from '../lib/teamCombination.js';
import { FORMAT } from '../lib/scoreValidator.js';
import { tierFor, TIER } from '../lib/placement.js';

function requireFinite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `ratingEngine: ${path} must be a finite number (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/**
 * M_margin — a MATCH-level scalar, applied identically to all four players.
 *
 * Built from the absolute games difference, so it is always in [0, 1] and
 * `√negative` cannot arise. There is deliberately no per-team ratio: a blowout is
 * equally strong evidence about both teams. Direction is carried by the sign of
 * the Glicko delta; credit is split by 2r. Neither is this term's job.
 */
function marginMultiplier(gamesA, gamesB, config) {
  const total = gamesA + gamesB;
  if (total <= 0) {
    throw new Error('ratingEngine: a match must have at least one game played.');
  }

  const base = requireFinite(config?.marginBase, 'config.marginBase');
  const coefficient = requireFinite(
    config?.marginCoefficient,
    'config.marginCoefficient',
  );

  const ratio = Math.abs(gamesA - gamesB) / total;
  return base + coefficient * Math.sqrt(ratio);
}

/** M_format — derived from set count upstream, never player-selected. */
function formatMultiplier(format, config) {
  if (format === FORMAT.SINGLE) {
    return requireFinite(config?.formatSingleSet, 'config.formatSingleSet');
  }
  if (format === FORMAT.THREE_SET) {
    return requireFinite(config?.formatThreeSet, 'config.formatThreeSet');
  }
  throw new Error(
    `ratingEngine: unknown format ${JSON.stringify(format)}. ` +
      `Expected "${FORMAT.SINGLE}" or "${FORMAT.THREE_SET}".`,
  );
}

/**
 * M_repeat — diminishing returns for a repeated identical matchup.
 *
 * `repeatCount` is the number of PRIOR occurrences of this same four-player
 * matchup within `repeatWindowDays`. Index 0 is therefore a first meeting.
 * Counts past the end of the table clamp to the last entry.
 */
function repeatMultiplier(repeatCount, config) {
  const table = config?.repeatMultipliers;
  if (!Array.isArray(table) || table.length === 0) {
    throw new Error('ratingEngine: config.repeatMultipliers must be a non-empty array.');
  }

  const count = requireFinite(repeatCount, 'context.repeatCount');
  if (count < 0 || !Number.isInteger(count)) {
    throw new Error(
      `ratingEngine: context.repeatCount must be a non-negative integer (got ${count}).`,
    );
  }

  return requireFinite(
    table[Math.min(count, table.length - 1)],
    `config.repeatMultipliers[${Math.min(count, table.length - 1)}]`,
  );
}

function toInternal(player) {
  return {
    mu: toMu(requireFinite(player?.rating, 'player.rating')),
    phi: toPhi(requireFinite(player?.rd, 'player.rd')),
    sigma: requireFinite(player?.sigma, 'player.sigma'),
  };
}

/**
 * Scale how much confidence a match buys, by how informative the match was.
 *
 * `phiStar` is the pre-match RD inflated by volatility — i.e. what RD would be
 * had the match taught us nothing. `phiPrime` is the full Glicko result — what
 * RD is if the match was a whole observation. Interpolating between them treats
 * the match as a FRACTIONAL observation:
 *
 *   adjusted = phiStar − informativeness · (phiStar − phiPrime)
 *
 * At informativeness = 1 this returns phiPrime exactly: the unmodified Glicko
 * result. At 0.65 the player keeps more uncertainty, because a single set is
 * 0.65 of an observation for confidence just as it is for rating.
 *
 * Applying this once per multiplier is algebraically identical to applying it
 * once with their product, since (phiStar − adjusted) is itself a multiple of
 * (phiStar − phiPrime). So the factors are composed and applied once.
 */
function scaleConfidence(phiStarValue, phiPrime, informativeness) {
  return phiStarValue - informativeness * (phiStarValue - phiPrime);
}

/**
 * Compute rating deltas and new state for all four players in one match.
 *
 * @param {object} input
 * @param {{A: {players: object[], isMixed: boolean, hasPlayedTogether: boolean},
 *          B: {players: object[], isMixed: boolean, hasPlayedTogether: boolean}}} input.teams
 *   Two players per team, each `{ id, rating, rd, sigma, gamesPlayed }` in
 *   display scale. `gamesPlayed` is needed to determine tier, which decides cap
 *   exemption. `isMixed` and `hasPlayedTogether` describe THAT team only —
 *   never the match.
 * @param {{winner: 'A'|'B', format: string, gamesA: number, gamesB: number}} input.score
 *   As returned by the score validator, already validated.
 * @param {{repeatCount: number}} input.context Prior occurrences of this exact
 *   four-player matchup within the repeat window.
 * @param {object} input.config The rating config document.
 * @returns {{configVersion: number, multipliers: object, teams: object, players: object[]}}
 */
export function computeRatingUpdate({ teams, score, context, config }) {
  const { winner, format, gamesA, gamesB } = score ?? {};

  if (winner !== 'A' && winner !== 'B') {
    throw new Error(
      `ratingEngine: score.winner must be "A" or "B" (got ${JSON.stringify(winner)}).`,
    );
  }

  for (const side of ['A', 'B']) {
    const players = teams?.[side]?.players;
    if (!Array.isArray(players) || players.length !== 2) {
      throw new Error(`ratingEngine: team ${side} must have exactly two players.`);
    }
  }

  const tau = requireFinite(config?.tau, 'config.tau');
  const maxDelta = requireFinite(config?.maxDeltaPerMatch, 'config.maxDeltaPerMatch');

  // Match-level multipliers — identical for all four players.
  const mFormat = formatMultiplier(format, config);
  const mMargin = marginMultiplier(
    requireFinite(gamesA, 'score.gamesA'),
    requireFinite(gamesB, 'score.gamesB'),
    config,
  );
  const mRepeat = repeatMultiplier(context?.repeatCount, config);

  // How much of a whole observation this match is worth. Only the multipliers
  // that express INFORMATION belong here — M_margin and 2r do not.
  const informativeness = mFormat * mRepeat;

  // Collapse each pair into one synthetic opponent entity. Each team's own
  // pairing flags are used — a team never inherits its opponents'.
  const entities = {};
  for (const side of ['A', 'B']) {
    const { players, isMixed, hasPlayedTogether } = teams[side];
    entities[side] = combineTeam(
      toInternal(players[0]),
      toInternal(players[1]),
      { isMixed, hasPlayedTogether },
      config,
    );
  }

  const results = [];

  for (const side of ['A', 'B']) {
    const opposing = side === 'A' ? entities.B : entities.A;
    const entity = entities[side];
    const outcome = winner === side ? 1 : 0;

    teams[side].players.forEach((player, index) => {
      const before = toInternal(player);
      const tier = tierFor(
        { rd: player.rd, gamesPlayed: player.gamesPlayed },
        config,
      );

      // Each player is updated INDIVIDUALLY against the opposing team entity.
      // Teammates are never opponents to each other.
      const updated = updatePlayer(
        before,
        { mu: opposing.mu, phi: opposing.phi },
        outcome,
        tau,
      );

      const rawDelta = (updated.mu - before.mu) * GLICKO_SCALE;

      // The weak link carries r = w; the strong link carries r = 1 − w.
      const isWeakLink = entity.weakLink === (index === 0 ? 'A' : 'B');
      const r = responsibility(entity.w, isWeakLink);
      const mResponsibility = 2 * r;

      const scaledDelta = rawDelta * mResponsibility * mFormat * mMargin * mRepeat;

      // Placement players are EXEMPT from the cap. Capping the delta while
      // leaving RD to shrink would leave a newcomer confident in a rating we
      // refused to let move — strictly worse than a large swing. With placement
      // exempt, the cap only ever sees provisional and established players,
      // whose deltas are far below it, so it is a true bug backstop.
      const capExempt = tier === TIER.PLACEMENT;
      const finalDelta = capExempt
        ? scaledDelta
        : Math.max(-maxDelta, Math.min(maxDelta, scaledDelta));

      // Confidence scales by how informative the match was. M_margin and 2r are
      // excluded: they express direction and credit, not information.
      const ps = phiStar(before.phi, updated.sigma);
      const adjustedPhi = scaleConfidence(ps, updated.phi, informativeness);

      results.push({
        id: player.id,
        team: side,
        tier,
        isWeakLink,
        capExempt,
        rawDelta,
        multipliers: {
          responsibility: mResponsibility,
          format: mFormat,
          margin: mMargin,
          repeat: mRepeat,
        },
        // How much of a whole observation this match counted for, which is what
        // scaled the RD shrinkage. Recorded so the audit trail explains RD too.
        informativeness,
        scaledDelta,
        finalDelta,
        capped: finalDelta !== scaledDelta,
        before: { rating: player.rating, rd: player.rd, sigma: player.sigma },
        after: {
          rating: player.rating + finalDelta,
          rd: toRd(adjustedPhi),
          // Volatility is not scaled: it peaks at ~0.0603 even under maximum
          // surprise, so the correction would be second-order.
          sigma: updated.sigma,
        },
      });
    });
  }

  return {
    // Every ratingHistory entry must record the config version that produced it.
    configVersion: config?.version ?? null,
    multipliers: { format: mFormat, margin: mMargin, repeat: mRepeat },
    teams: {
      A: { mu: entities.A.mu, phi: entities.A.phi, w: entities.A.w, weakLink: entities.A.weakLink },
      B: { mu: entities.B.mu, phi: entities.B.phi, w: entities.B.w, weakLink: entities.B.weakLink },
    },
    players: results,
  };
}
