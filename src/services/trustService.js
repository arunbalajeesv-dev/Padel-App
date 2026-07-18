/**
 * trustScore read layer — derives a player's sportsmanship score from trustLogs.
 *
 * The aggregation is pure (src/lib/trustScore.js). This service only fetches the
 * raw feedback and applies it. The score is NEVER stored and NEVER rendered raw
 * to players — admin visibility and later reporter-weighting are its only
 * consumers. See CLAUDE.md > Peer Feedback.
 */
import { getFirestore } from '../config/firebase.js';
import { TRUST_LOGS_COLLECTION } from './feedbackService.js';
import { aggregateTrust } from '../lib/trustScore.js';

/**
 * A single player's trust score and its supporting context.
 *
 * @returns {Promise<{userId, trustScore, reviewCount, rawMean}>}
 */
export async function trustFor(uid, config) {
  const snap = await getFirestore()
    .collection(TRUST_LOGS_COLLECTION)
    .where('subjectUid', '==', uid)
    .get();

  const agg = aggregateTrust(snap.docs.map((d) => d.data()), config);
  return { userId: uid, ...agg };
}

/**
 * Trust scores for every player who has received feedback, plus the lowest
 * first — the admin cares about the bottom of the distribution, where a
 * sportsmanship problem lives.
 *
 * Grouped in memory from a single trustLogs read rather than one query per
 * player: the collection is small (a few entries per confirmed match) and this
 * avoids an N+1 across the whole roster.
 *
 * @returns {Promise<object[]>}
 */
export async function trustLeaderboard(config) {
  const snap = await getFirestore().collection(TRUST_LOGS_COLLECTION).get();

  const bySubject = new Map();
  for (const doc of snap.docs) {
    const { subjectUid } = doc.data();
    if (!subjectUid) continue;
    if (!bySubject.has(subjectUid)) bySubject.set(subjectUid, []);
    bySubject.get(subjectUid).push(doc.data());
  }

  const rows = [...bySubject.entries()].map(([userId, entries]) => ({
    userId,
    ...aggregateTrust(entries, config),
  }));

  // Lowest trust first — that is the row an admin is looking for.
  rows.sort((a, b) => a.trustScore - b.trustScore);
  return rows;
}
