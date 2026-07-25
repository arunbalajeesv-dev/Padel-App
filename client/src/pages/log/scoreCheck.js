/**
 * Client-side score plausibility — for IMMEDIATE feedback only.
 *
 * The server is the source of truth on score legality (src/lib/scoreValidator.js
 * decides what counts and derives the format). This mirror exists so a player
 * sees "that isn't a valid set" as they type, instead of after a round trip. It
 * must never be trusted in place of the server, and it computes NO format — the
 * format is the server's to derive, because a client-chosen format is a gaming
 * vector.
 *
 * Keep these endings in step with LEGAL_SET_ENDINGS on the server.
 */
export const LEGAL_SET_ENDINGS = [
  [6, 0], [6, 1], [6, 2], [6, 3], [6, 4], [7, 5], [7, 6],
];

const MAX_SETS = 3;

/** Is this pair of game counts a legal padel set ending (either direction)? */
export function isLegalSet(a, b) {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return false;
  if (a === b) return false; // a set cannot end level
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return LEGAL_SET_ENDINGS.some(([h, l]) => h === hi && l === lo);
}

/**
 * A short, human reason a set is not yet valid — or null if it is fine.
 * Deliberately gentle: a fresh 0-0 set is "incomplete", not "illegal".
 */
export function setHint(set) {
  const a = set?.teamA;
  const b = set?.teamB;
  if (a === 0 && b === 0) return 'Enter the games for this set.';
  if (a === b) return "A set can't end level.";
  if (!isLegalSet(a, b)) return 'Not a valid set — e.g. 6-4, 7-5 or 7-6.';
  return null;
}

/**
 * Overall check across all sets entered.
 *
 * @returns {{ ready: boolean, perSet: (string|null)[], formatLabel: string }}
 *   `ready` means every set looks legal and the count is 1-3. `formatLabel` is
 *   DISPLAY ONLY — the server derives the real format from the set count.
 */
export function checkSets(sets) {
  const list = Array.isArray(sets) ? sets : [];
  const perSet = list.map(setHint);

  const countOk = list.length >= 1 && list.length <= MAX_SETS;
  const ready = countOk && perSet.every((hint) => hint === null);

  const formatLabel =
    list.length === 1 ? 'Single set' : list.length >= 2 ? 'Best of three' : '';

  return { ready, perSet, formatLabel };
}

/** Who won each completed set, for the running summary. Never sent to the server. */
export function setsWonByTeam(sets) {
  let mine = 0;
  let theirs = 0;
  for (const s of sets ?? []) {
    if (!isLegalSet(s.teamA, s.teamB)) continue;
    if (s.teamA > s.teamB) mine += 1;
    else theirs += 1;
  }
  return { mine, theirs };
}
