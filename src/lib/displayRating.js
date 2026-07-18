/**
 * The 0–7 display rating.
 *
 * Pure. Constants injected.
 *
 * ---------------------------------------------------------------------------
 * DERIVED, NEVER STORED.
 *
 * `ratingDisplay` is computed in the response layer from the canonical rating.
 * It is NOT a field on the user document. A stored copy would be a second
 * source of truth that drifts the moment the mapping is retuned, and every
 * historical rating would then disagree with the number beside it.
 *
 * The leaderboard still sorts correctly without it: the map is monotonic in
 * rating, so ordering by `rating.value` gives exactly the ordering by display.
 * ---------------------------------------------------------------------------
 *
 * NOTE: how this number is RENDERED is Open Question 1 — a single decimal
 * overclaims precision by ~11x. This module produces the value; it does not
 * decide how many digits of it are honest to show.
 */

function requireFinite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `displayRating: config.${path} must be a finite number (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/**
 * Map a canonical rating onto the 0–7 display scale.
 *
 * @param {number} rating Canonical 1500-scale rating.
 * @param {object} config Needs displayScale.{ratingAtZero, ratingAtMax, maxUnits}.
 * @returns {number} Clamped to [0, maxUnits]. Unrounded — rounding is a
 *   presentation decision, and Open Question 1 has not settled it.
 */
export function toDisplayRating(rating, config) {
  const r = requireFinite(rating, 'rating — passed by caller');
  const atZero = requireFinite(config?.displayScale?.ratingAtZero, 'displayScale.ratingAtZero');
  const atMax = requireFinite(config?.displayScale?.ratingAtMax, 'displayScale.ratingAtMax');
  const maxUnits = requireFinite(config?.displayScale?.maxUnits, 'displayScale.maxUnits');

  if (atMax <= atZero) {
    throw new Error('displayRating: displayScale.ratingAtMax must exceed ratingAtZero.');
  }

  const units = ((r - atZero) / (atMax - atZero)) * maxUnits;
  return Math.min(maxUnits, Math.max(0, units));
}
