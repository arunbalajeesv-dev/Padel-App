/**
 * Pure padel score validation. No database, no HTTP, no config — the legal set
 * endings are the rules of the sport, not tunable constants, so they live here
 * rather than in config/rating.
 */

/** Legal set endings as [winnerGames, loserGames]. Applies in either direction. */
export const LEGAL_SET_ENDINGS = Object.freeze([
  [6, 0],
  [6, 1],
  [6, 2],
  [6, 3],
  [6, 4],
  [7, 5],
  [7, 6],
]);

export const FORMAT = Object.freeze({
  SINGLE: 'single',
  THREE_SET: 'threeSet',
});

const MAX_SETS = 3;

// First to 10, win by 2. Used only to give a pointed error instead of a generic
// "not a legal set" when someone submits a championship tiebreak.
const TIEBREAK_TARGET = 10;

const LEGAL_ENDINGS_TEXT = '6-0, 6-1, 6-2, 6-3, 6-4, 7-5, 7-6';

function isLegalEnding(winnerGames, loserGames) {
  return LEGAL_SET_ENDINGS.some(([w, l]) => w === winnerGames && l === loserGames);
}

function isValidGameCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function setWinner(set) {
  return set.teamA > set.teamB ? 'A' : 'B';
}

function looksLikeChampionshipTiebreak(high, low) {
  return high >= TIEBREAK_TARGET && high - low >= 2;
}

/**
 * Validate a padel match score.
 *
 * @param {Array<{teamA: number, teamB: number}>} sets Games per team, in order.
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   winner: 'A'|'B'|null,
 *   format: 'single'|'threeSet'|null,
 *   gamesA: number,
 *   gamesB: number,
 * }} `errors` carries human-readable messages for the UI; `winner` and `format`
 *   are null when the score is not a finished, legal match.
 */
export function validateScore(sets) {
  const errors = [];

  if (!Array.isArray(sets)) {
    return {
      valid: false,
      errors: ['Score must be an array of sets.'],
      winner: null,
      format: null,
      gamesA: 0,
      gamesB: 0,
    };
  }

  // Set count. Format derives from the number of sets and is never chosen by a
  // player — a selectable multiplier would be a gaming vector.
  if (sets.length === 0) {
    errors.push('A match must have at least one set.');
  } else if (sets.length > MAX_SETS) {
    errors.push(`A match cannot have more than three sets (got ${sets.length}).`);
  }

  const format =
    sets.length === 1
      ? FORMAT.SINGLE
      : sets.length === 2 || sets.length === 3
        ? FORMAT.THREE_SET
        : null;

  // Per-set legality.
  let allSetsLegal = sets.length > 0 && sets.length <= MAX_SETS;

  sets.forEach((set, index) => {
    const label = `Set ${index + 1}`;
    const teamA = set?.teamA;
    const teamB = set?.teamB;

    if (!isValidGameCount(teamA) || !isValidGameCount(teamB)) {
      errors.push(`${label}: games must be whole numbers of 0 or more.`);
      allSetsLegal = false;
      return;
    }

    if (teamA === teamB) {
      errors.push(
        `${label}: ${teamA}-${teamB} is not a legal set score — a set cannot end level.`,
      );
      allSetsLegal = false;
      return;
    }

    const high = Math.max(teamA, teamB);
    const low = Math.min(teamA, teamB);

    if (isLegalEnding(high, low)) return;

    // A ten-point tiebreak in the deciding set is the most likely mistake, so
    // name it rather than emitting a generic rejection.
    if (index === 2 && looksLikeChampionshipTiebreak(high, low)) {
      errors.push(
        `${label}: ${teamA}-${teamB} looks like a championship tiebreak. ` +
          'Championship tiebreaks are not supported — the third set must be a ' +
          `real set ending ${LEGAL_ENDINGS_TEXT}.`,
      );
    } else {
      errors.push(
        `${label}: ${teamA}-${teamB} is not a legal set score. ` +
          `Legal endings are ${LEGAL_ENDINGS_TEXT}.`,
      );
    }

    allSetsLegal = false;
  });

  // Sequence coherence. Only meaningful once every set has a known winner —
  // otherwise this would pile confusing errors on top of an illegal set.
  let winner = null;

  if (allSetsLegal) {
    const winners = sets.map(setWinner);
    const setsWonByA = winners.filter((w) => w === 'A').length;
    const setsWonByB = winners.length - setsWonByA;

    if (sets.length === 1) {
      winner = winners[0];
    } else if (sets.length === 2) {
      if (setsWonByA === 1) {
        errors.push(
          'Match is not finished: each team won one set. A deciding third set is required.',
        );
      } else {
        winner = setsWonByA === 2 ? 'A' : 'B';
      }
    } else if (winners[0] === winners[1]) {
      const leader = winners[0] === 'A' ? 'Team A' : 'Team B';
      errors.push(
        `Match should have ended after two sets: ${leader} won both, ` +
          'so a third set cannot exist.',
      );
    } else {
      winner = setsWonByA === 2 ? 'A' : 'B';
    }
  }

  // Total games are reported regardless of legality so the UI can echo back what
  // was entered alongside the errors.
  let gamesA = 0;
  let gamesB = 0;
  for (const set of sets) {
    if (isValidGameCount(set?.teamA)) gamesA += set.teamA;
    if (isValidGameCount(set?.teamB)) gamesB += set.teamB;
  }

  return {
    valid: errors.length === 0,
    errors,
    winner: errors.length === 0 ? winner : null,
    format: errors.length === 0 ? format : null,
    gamesA,
    gamesB,
  };
}
