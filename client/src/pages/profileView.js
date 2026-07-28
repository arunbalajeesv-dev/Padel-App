/**
 * Pure presentation helpers for Profile. No rendering, no rating math — see
 * homeView.js for the same discipline. tierLabel/reliability already live
 * there and are reused rather than duplicated here.
 */

/** "Member since Jul 2026" from the user doc's createdAt. */
export function memberSince(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const formatted = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  return `Member since ${formatted}`;
}

/** "1 match" / "N matches" — copy only, gamesPlayed itself comes from the API. */
export function gamesPlayedLabel(gamesPlayed) {
  if (typeof gamesPlayed !== 'number' || !Number.isFinite(gamesPlayed)) return 'Matches played';
  return gamesPlayed === 1 ? 'Match played' : 'Matches played';
}

/** "Male" / "Female" from the stored gender code. Falls back rather than throws. */
export function genderLabel(gender) {
  if (gender === 'M') return 'Male';
  if (gender === 'F') return 'Female';
  return '—';
}
