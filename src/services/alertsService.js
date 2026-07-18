/**
 * Weekly-gain alert — the human's collusion lens.
 *
 * ===========================================================================
 * THIS PRESENTS. IT DOES NOT ADJUDICATE.
 *
 * A genuine winning streak and a collusion ring are IDENTICAL in the data — a
 * player gaining steadily against opponents who confirm the results. Software
 * cannot separate them; that is exactly why the weekly gain CAP was deleted (it
 * would have punished both or neither). This endpoint instead surfaces the
 * pattern for a human who knows the players and can apply the context the data
 * lacks: who these people are, whether the matches plausibly happened, whether
 * the same few names keep pairing up.
 *
 * So it returns evidence, never a verdict. The threshold selects candidates; the
 * admin decides. Critically it reports `distinctOpponents`, which is the real
 * signal: a ring is a handful of people farming each other (few distinct
 * opponents), a streak is one player beating the field (many). See CLAUDE.md >
 * Anti-Abuse Rules and the deleted weeklyGainCap.
 * ===========================================================================
 */
import { getFirestore } from '../config/firebase.js';
import { USERS_COLLECTION } from './usersService.js';
import { MATCHES_COLLECTION, STATUS } from './matchesService.js';
import { RATING_HISTORY_COLLECTION } from './confirmationService.js';

const DAY_MS = 86_400_000;

/**
 * Sum of a player's UPWARD rating moves over the given entries — not the net.
 *
 * Losses do not offset gains: netting would let a ring interleave real losses to
 * mask farmed wins. We are measuring how far a rating ROSE, which is the thing a
 * colluder is trying to manufacture. Inactivity-decay entries have
 * ratingAfter == ratingBefore and so contribute nothing.
 *
 * @param {{ratingBefore: number, ratingAfter: number}[]} entries
 * @returns {number} >= 0
 */
export function sumPositiveGain(entries) {
  return (entries ?? []).reduce((acc, e) => {
    const before = Number(e?.ratingBefore);
    const after = Number(e?.ratingAfter);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return acc;
    return acc + Math.max(0, after - before);
  }, 0);
}

/** Matches a player played in the window: count and distinct opponents. */
async function windowMatchContext(db, uid, windowStart) {
  // array-contains alone is served by the automatic index — no composite needed.
  const snap = await db
    .collection(MATCHES_COLLECTION)
    .where('players', 'array-contains', uid)
    .get();

  const opponents = new Set();
  let matchCount = 0;

  for (const doc of snap.docs) {
    const m = doc.data();
    if (m.status !== STATUS.CONFIRMED) continue;
    if (!m.playedAt || m.playedAt < windowStart) continue;

    matchCount += 1;
    const onA = (m.teamA ?? []).includes(uid);
    for (const opp of onA ? m.teamB ?? [] : m.teamA ?? []) opponents.add(opp);
  }

  return { matchCount, distinctOpponents: opponents.size };
}

/**
 * Players whose 7-day rating gain exceeds the configured alert threshold.
 *
 * @param {object} config Needs weeklyGainAlertThreshold and
 *   weeklyGainAlertWindowDays.
 * @returns {Promise<{threshold, windowDays, windowStart, players: object[]}>}
 *   `players` sorted by gain descending, each with the collusion context.
 */
export async function weeklyGainAlerts(config) {
  const db = getFirestore();
  const threshold = config.weeklyGainAlertThreshold;
  const windowDays = config.weeklyGainAlertWindowDays;
  const windowStart = new Date(Date.now() - windowDays * DAY_MS).toISOString();

  const usersSnap = await db.collection(USERS_COLLECTION).get();

  const flagged = [];
  for (const userDoc of usersSnap.docs) {
    const historySnap = await db
      .collection(USERS_COLLECTION)
      .doc(userDoc.id)
      .collection(RATING_HISTORY_COLLECTION)
      .where('createdAt', '>=', windowStart)
      .get();

    const gain = sumPositiveGain(historySnap.docs.map((d) => d.data()));
    if (gain < threshold) continue;

    // Enrich only the flagged few with match-derived context.
    const context = await windowMatchContext(db, userDoc.id, windowStart);
    const user = userDoc.data();
    flagged.push({
      userId: userDoc.id,
      name: user.name ?? null,
      status: user.status ?? null,
      gain: Math.round(gain),
      ...context,
    });
  }

  flagged.sort((a, b) => b.gain - a.gain);

  return { threshold, windowDays, windowStart, players: flagged };
}
