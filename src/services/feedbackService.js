/**
 * Peer feedback — sportsmanship only.
 *
 * ===========================================================================
 * THIS MODULE MUST NEVER TOUCH THE SKILL RATING OR ITS CONFIDENCE. NOT EVER.
 * NOT INDIRECTLY.
 *
 * It writes exactly two things: a `feedback` document and `trustLogs` entries.
 * It does not read or write `rating` (µ, RD or σ), does not write
 * `ratingHistory`, and does not import the rating engine. If a future change
 * makes this file import from ratingEngine.js, glicko2.js or teamCombination.js,
 * that change is wrong.
 *
 * WHY, so nobody gets clever about it later:
 *
 * The moment sportsmanship moves the ladder, the ladder becomes a popularity
 * contest. Players would rate opponents down to gain rank, and every rating
 * would encode "who is liked" alongside "who is good" with no way to separate
 * them afterwards. The skill rating is earned from match results and nothing
 * else — that is the entire premise of the system.
 *
 * The plausible-sounding version of this mistake is "it only nudges RD, not the
 * rating". RD IS off-limits too, and for the same reason: RD is confidence in a
 * skill estimate and may move only on match evidence. Feeding social sentiment
 * into RD would make a well-liked player's rating treated as more certain purely
 * because people like them — the same popularity-contest failure, one coordinate
 * over. CLAUDE.md > Peer Feedback forbids this explicitly; the earlier "feeds a
 * trust score and RD" wording is superseded. The trust score is a separate,
 * non-rating signal and stays that way.
 * ===========================================================================
 */
import { getFirestore } from '../config/firebase.js';
import { MATCHES_COLLECTION, playersOf } from './matchesService.js';

export const FEEDBACK_COLLECTION = 'feedback';
export const TRUST_LOGS_COLLECTION = 'trustLogs';

export const CREATABLE_FIELDS = Object.freeze(['matchId', 'ratings']);

/**
 * The sportsmanship scale, as COLLECTED. This module writes only the raw scores.
 *
 * There is NO `trustScore` field on the user document. The trust score is a
 * derived aggregate of trustLogs (append-only, complete), computed on read in
 * `trustService.js` — never stored. This module writes the raw evidence and
 * nothing else. See CLAUDE.md > Peer Feedback > trustScore.
 *
 * 1-5 rather than a 3-point scale for one reason: 5 collapses to 3 later, 3
 * never expands to 5. Store the finest resolution honestly collected.
 */
export const MIN_SCORE = 1;
export const MAX_SCORE = 5;

const httpError = (status, error, reason) =>
  Object.assign(new Error(reason), { status, error, reason });

const rejectedFields = (body) =>
  Object.keys(body ?? {}).filter((k) => !CREATABLE_FIELDS.includes(k));

const isScore = (v) => Number.isInteger(v) && v >= MIN_SCORE && v <= MAX_SCORE;

export function validateCreate(body) {
  const errors = [];
  const b = body ?? {};

  if (typeof b.matchId !== 'string' || b.matchId.trim().length === 0) {
    errors.push('matchId is required.');
  }

  if (b.ratings === null || typeof b.ratings !== 'object' || Array.isArray(b.ratings)) {
    errors.push('ratings must be an object mapping player uid to a score.');
  } else {
    for (const [uid, score] of Object.entries(b.ratings)) {
      if (!isScore(score)) {
        errors.push(
          `ratings.${uid} must be an integer from ${MIN_SCORE} to ${MAX_SCORE}.`,
        );
      }
    }
  }

  return { rejected: rejectedFields(body), errors };
}

/**
 * Submit sportsmanship feedback for the other three players in a match.
 *
 * @param {{uid: string, body: object}} input
 * @returns {Promise<{feedback: object}>}
 */
export async function submitFeedback({ uid, body }) {
  const db = getFirestore();
  const { matchId, ratings } = body;

  return db.runTransaction(async (tx) => {
    const matchSnap = await tx.get(db.collection(MATCHES_COLLECTION).doc(matchId));
    if (!matchSnap.exists) throw httpError(404, 'Not Found', 'no such match');

    const match = { id: matchSnap.id, ...matchSnap.data() };
    const players = playersOf(match);

    if (!players.includes(uid)) {
      throw httpError(403, 'Forbidden', 'You can only rate a match you played in.');
    }

    // The other three. A player never rates themselves, and never rates someone
    // who was not on the court.
    const subjects = players.filter((id) => id !== uid);
    const given = Object.keys(ratings);

    const missing = subjects.filter((id) => !given.includes(id));
    const unexpected = given.filter((id) => !subjects.includes(id));

    if (missing.length > 0 || unexpected.length > 0) {
      const problems = [];
      if (missing.length > 0) problems.push(`missing: ${missing.join(', ')}`);
      if (unexpected.length > 0) problems.push(`not your opponents: ${unexpected.join(', ')}`);
      throw httpError(
        400,
        'Bad Request',
        `ratings must cover exactly the other three players (${problems.join('; ')}).`,
      );
    }

    // One submission per player per match. The id is derived rather than
    // queried, so the check is atomic inside the transaction: a double-tap
    // cannot produce two submissions.
    const feedbackRef = db.collection(FEEDBACK_COLLECTION).doc(`${matchId}__${uid}`);
    if ((await tx.get(feedbackRef)).exists) {
      throw httpError(409, 'Conflict', 'you have already rated this match');
    }

    const now = new Date().toISOString();

    tx.create(feedbackRef, {
      matchId,
      fromUid: uid,
      ratings: { ...ratings },
      createdAt: now,
    });

    // One append per recipient. This is the raw evidence any future trust score
    // is computed FROM — never a running total, which would be a second source
    // of truth that could not be recomputed or corrected.
    for (const subject of subjects) {
      tx.create(db.collection(TRUST_LOGS_COLLECTION).doc(), {
        subjectUid: subject,
        fromUid: uid,
        matchId,
        score: ratings[subject],
        createdAt: now,
      });
    }

    return {
      feedback: { id: feedbackRef.id, matchId, fromUid: uid, ratings, createdAt: now },
    };
  });
}
