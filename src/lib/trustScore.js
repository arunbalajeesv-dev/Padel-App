/**
 * trustScore — sportsmanship reputation, aggregated from peer feedback.
 *
 * Pure. Constants injected. Takes raw trustLogs entries in, returns a score out.
 *
 * ===========================================================================
 * NEVER TOUCHES THE SKILL RATING OR RD.
 *
 * This score is computed from `trustLogs` (peer sportsmanship feedback) and is
 * used for admin visibility and, later, reporter-weighting. It has nothing to do
 * with µ, RD, σ, or the ladder. Peer feedback is sportsmanship only — the moment
 * it moves the rating, the ladder becomes a popularity contest. See CLAUDE.md >
 * Peer Feedback.
 *
 * INTERNAL ONLY. The raw score is never rendered to players. A visible
 * sportsmanship number is a public shaming mechanism and a brigading target.
 * ===========================================================================
 *
 * DERIVED ON READ, NEVER STORED.
 *
 * The source of truth is `trustLogs`, which is append-only and complete. Storing
 * an aggregate would be a second source of truth that drifts the instant the
 * formula changes — and this formula WILL be tuned once there is real data. As a
 * derived value, any change recomputes retroactively over the full history for
 * free. The `trustScore: 0` field on the user document is vestigial; do not read
 * it as the score. See CLAUDE.md > Peer Feedback > trustScore.
 *
 * THE FORMULA — a shrunk mean, neutral at 0.5.
 *
 *   normalise each 1-5 score to [0,1]:   (score - 1) / 4
 *   trustScore = (Σ normalised + k · 0.5) / (n + k)
 *
 * where k = `trustScorePriorWeight`. A player with no feedback sits at exactly
 * 0.5 (neutral) — never punished for lack of data, and raw volume alone cannot
 * inflate the score. One bad review nudges rather than condemns; the score only
 * approaches the raw mean once enough reviews accumulate to overcome the prior.
 */

const RAW_MIN = 1;
const RAW_MAX = 5;
const NEUTRAL = 0.5;

function requireFinite(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `trustScore: ${path} must be a finite number (got ${JSON.stringify(value)}).`,
    );
  }
  return value;
}

/** Map a raw 1-5 sportsmanship score onto [0,1]. */
export function normaliseScore(raw) {
  requireFinite(raw, 'score');
  if (raw < RAW_MIN || raw > RAW_MAX) {
    throw new Error(`trustScore: score ${raw} is outside the ${RAW_MIN}-${RAW_MAX} scale.`);
  }
  return (raw - RAW_MIN) / (RAW_MAX - RAW_MIN);
}

/**
 * Aggregate a player's trustLogs entries into a score and its context.
 *
 * @param {{score: number}[]} entries The player's received feedback.
 * @param {object} config Needs trustScorePriorWeight.
 * @returns {{trustScore: number, reviewCount: number, rawMean: number|null}}
 *   `trustScore` in [0,1]; `rawMean` is null when there is no feedback, so the
 *   admin can tell "neutral because unrated" from "neutral because middling".
 */
export function aggregateTrust(entries, config) {
  const k = requireFinite(config?.trustScorePriorWeight, 'config.trustScorePriorWeight');
  const scores = (entries ?? []).map((e) => normaliseScore(e?.score));
  const n = scores.length;
  const sum = scores.reduce((acc, s) => acc + s, 0);

  return {
    trustScore: (sum + k * NEUTRAL) / (n + k),
    reviewCount: n,
    rawMean: n === 0 ? null : sum / n,
  };
}
