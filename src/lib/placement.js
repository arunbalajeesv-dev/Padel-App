/**
 * Placement status and the leaderboard countdown.
 *
 * Pure functions. Constants arrive via an injected `config` object.
 *
 * THE RULE: show a number only when it is guaranteed. Never estimate.
 *
 * The games floor is computable — `floor - gamesPlayed` is arithmetic. The RD
 * side is not: how fast RD falls depends on opponent RD and match outcomes, so
 * any RD-based countdown is a forecast dressed as a fact. We do not show one.
 *
 * A countdown that promises "one more match" and then fails to deliver breaks
 * trust on the exact screen where we are asking players to trust the ratings.
 *
 * See CLAUDE.md > "The leaderboard countdown".
 */

/** A player's tier. Both the RD bound and the games floor must clear to advance. */
export const TIER = Object.freeze({
  PLACEMENT: 'placement',
  PROVISIONAL: 'provisional',
  ESTABLISHED: 'established',
});

/** What the UI should render. */
export const PLACEMENT_STATUS = Object.freeze({
  /** Out of placement — on the leaderboard. No message. */
  VISIBLE: 'visible',
  /** RD is clear; only the games floor remains. Show the exact number. */
  COUNTING: 'counting',
  /** RD is still above the threshold. Show fallback copy, never a number. */
  SETTLING: 'settling',
});

function requireFinite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `placement: config.${path} must be a finite number (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/**
 * A player's tier, from RD and games played. Both conditions are ANDed.
 *
 * Bounds are strict: exactly at a threshold does not clear it.
 *
 * @param {{rd: number, gamesPlayed: number}} player Display-scale RD.
 * @param {object} config Needs rdThresholds and gamesPlayedFloors.
 * @returns {'placement'|'provisional'|'established'}
 */
export function tierFor(player, config) {
  const rd = requireFinite(player?.rd, 'player.rd — passed by caller');
  const gamesPlayed = requireFinite(
    player?.gamesPlayed,
    'player.gamesPlayed — passed by caller',
  );

  const placementRd = requireFinite(
    config?.rdThresholds?.placement,
    'rdThresholds.placement',
  );
  const provisionalRd = requireFinite(
    config?.rdThresholds?.provisional,
    'rdThresholds.provisional',
  );
  const provisionalFloor = requireFinite(
    config?.gamesPlayedFloors?.provisional,
    'gamesPlayedFloors.provisional',
  );
  const establishedFloor = requireFinite(
    config?.gamesPlayedFloors?.established,
    'gamesPlayedFloors.established',
  );

  if (rd < provisionalRd && gamesPlayed >= establishedFloor) return TIER.ESTABLISHED;
  if (rd < placementRd && gamesPlayed >= provisionalFloor) return TIER.PROVISIONAL;
  return TIER.PLACEMENT;
}

/**
 * Decide what the leaderboard should tell a player about their placement.
 *
 * Three outcomes, and only one of them carries a number:
 *
 * - `VISIBLE`   — both conditions met; the player is on the leaderboard.
 * - `COUNTING`  — `RD < placement` already, so the ONLY thing left is playing
 *                 matches. `matchesRemaining` is then exactly true: it is the
 *                 arithmetic difference against the floor, not a projection.
 * - `SETTLING`  — `RD >= placement`. We cannot say how many matches that will
 *                 take, so we say nothing. `matchesRemaining` is null.
 *
 * Note the asymmetry is deliberate. In COUNTING we could be wrong only in a
 * pathological corner (see CLAUDE.md); in SETTLING we would be wrong routinely,
 * because RD's trajectory depends on who the player happens to draw next.
 *
 * @param {{rd: number, gamesPlayed: number}} player Display-scale RD.
 * @param {object} config Needs rdThresholds.placement and
 *   gamesPlayedFloors.provisional.
 * @returns {{status: string, matchesRemaining: number|null}}
 */
export function placementCountdown(player, config) {
  const rd = requireFinite(player?.rd, 'player.rd — passed by caller');
  const gamesPlayed = requireFinite(
    player?.gamesPlayed,
    'player.gamesPlayed — passed by caller',
  );

  const rdThreshold = requireFinite(
    config?.rdThresholds?.placement,
    'rdThresholds.placement',
  );
  const gamesFloor = requireFinite(
    config?.gamesPlayedFloors?.provisional,
    'gamesPlayedFloors.provisional',
  );

  // Strict bound: exactly at the threshold is still placement.
  const rdIsClear = rd < rdThreshold;
  const gamesAreClear = gamesPlayed >= gamesFloor;

  if (rdIsClear && gamesAreClear) {
    return { status: PLACEMENT_STATUS.VISIBLE, matchesRemaining: null };
  }

  // RD outstanding — its trajectory is not ours to promise, whatever the games
  // count says. Even if the floor is also unmet, we cannot show that number:
  // clearing the floor would not put the player on the leaderboard.
  if (!rdIsClear) {
    return { status: PLACEMENT_STATUS.SETTLING, matchesRemaining: null };
  }

  // RD is clear, so matches are the only remaining condition. Exact.
  return {
    status: PLACEMENT_STATUS.COUNTING,
    matchesRemaining: gamesFloor - gamesPlayed,
  };
}
