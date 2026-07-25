/**
 * Pure presentation helpers for Home. No rendering, no rating math — these only
 * shape values the API already computed into copy and labels. Kept pure so the
 * copy rules (especially the placement countdown) are testable in isolation.
 */

/** Tier label from the server-assigned status. Never derived from a rating. */
export function tierLabel(status) {
  switch (status) {
    case 'established':
      return 'Established';
    case 'provisional':
      return 'Provisional';
    case 'placement':
      return 'Placement';
    default:
      return '—';
  }
}

/**
 * Reliability shown to the player, mapped from the TIER the server assigned —
 * not from RD, which the client never sees. The tier IS the reliability
 * classification, so this is a relabelling, not a computation.
 *
 * @returns {{label: string, fill: number}} fill is a 0-1 bar fraction.
 */
export function reliability(status) {
  switch (status) {
    case 'established':
      return { label: 'High', fill: 1 };
    case 'provisional':
      return { label: 'Medium', fill: 0.66 };
    case 'placement':
      return { label: 'Building', fill: 0.33 };
    default:
      return { label: '—', fill: 0 };
  }
}

/**
 * The placement message, straight from the backend's countdown decision.
 *
 * The backend returns `{ status, matchesRemaining }` where status is
 * 'visible' | 'counting' | 'settling'. We show an exact number ONLY in the
 * counting state, where the API guarantees it. In settling we show no number —
 * never an estimate — because RD's trajectory is not ours to promise. See
 * CLAUDE.md > "The leaderboard countdown".
 *
 * @returns {{show: boolean, text: string}} show is false once the player is on
 *   the board (nothing to say).
 */
export function placementMessage(placement) {
  if (!placement || placement.status === 'visible') {
    return { show: false, text: '' };
  }

  if (placement.status === 'counting') {
    const n = placement.matchesRemaining;
    const noun = n === 1 ? 'match' : 'matches';
    return { show: true, text: `${n} more ${noun} to appear on the leaderboard` };
  }

  // settling — and anything unexpected falls here too, which is the safe side:
  // the fallback copy promises nothing.
  return { show: true, text: 'Your rating is still settling — keep playing.' };
}

/** "6-2, 6-3" from the sets array. */
export function formatScore(sets) {
  if (!Array.isArray(sets) || sets.length === 0) return '';
  return sets.map((s) => `${s.teamA}-${s.teamB}`).join(', ');
}

/** A short, stable date like "15 Jul 2026". */
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Map a team's uids to display names, falling back to the uid if unresolved. */
export function teamNames(uids, names) {
  return (uids ?? []).map((uid) => names?.[uid] ?? uid);
}
