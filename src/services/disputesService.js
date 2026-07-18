/**
 * Disputes.
 *
 * A dispute says "this match did not happen as reported". What that means
 * depends entirely on whether the match has already been rated, and the two
 * cases are NOT variations of one flow — they are opposites.
 *
 * ---------------------------------------------------------------------------
 * A DISPUTED MATCH MUST NEVER AFFECT RATINGS
 *
 * For a PENDING match that is trivially satisfied: it has never been rated, and
 * `confirmationService` refuses to confirm anything whose status is not
 * `pending`. Setting the status to `disputed` therefore closes the door
 * permanently, with nothing to undo.
 *
 * For a CONFIRMED match the ratings are ALREADY APPLIED, and this service does
 * NOT reverse them. See `raiseDispute`.
 * ---------------------------------------------------------------------------
 */
import { getFirestore } from '../config/firebase.js';
import { MATCHES_COLLECTION, STATUS, playersOf } from './matchesService.js';

export const DISPUTES_COLLECTION = 'disputes';

export const DISPUTE_STATUS = Object.freeze({
  /** Raised against a match that was never rated. The match is now blocked. */
  OPEN: 'open',
  /** Raised against a match that WAS rated. A human must decide. */
  NEEDS_ADMIN_REVIEW: 'needsAdminReview',
  RESOLVED: 'resolved',
});

/** Statuses that mean a dispute is still live, so a second one is redundant. */
const LIVE = [DISPUTE_STATUS.OPEN, DISPUTE_STATUS.NEEDS_ADMIN_REVIEW];

export const CREATABLE_FIELDS = Object.freeze(['reason', 'evidenceUrl']);

const MIN_REASON = 10;
const MAX_REASON = 1000;

const httpError = (status, error, reason) =>
  Object.assign(new Error(reason), { status, error, reason });

const rejectedFields = (body) =>
  Object.keys(body ?? {}).filter((k) => !CREATABLE_FIELDS.includes(k));

export function validateCreate(body) {
  const errors = [];
  const b = body ?? {};

  if (typeof b.reason !== 'string' || b.reason.trim().length < MIN_REASON) {
    errors.push(`reason must be a string of at least ${MIN_REASON} characters.`);
  } else if (b.reason.length > MAX_REASON) {
    errors.push(`reason must be ${MAX_REASON} characters or fewer.`);
  }

  // Optional. Null is an explicit "no evidence", which is different from absent
  // only to the client — both are stored as null.
  if (b.evidenceUrl !== undefined && b.evidenceUrl !== null) {
    if (typeof b.evidenceUrl !== 'string' || !/^https?:\/\/\S+$/i.test(b.evidenceUrl)) {
      errors.push('evidenceUrl must be an http(s) URL or null.');
    }
  }

  return { rejected: rejectedFields(body), errors };
}

/**
 * Raise a dispute against a match.
 *
 * @param {{matchId: string, uid: string, body: object}} input
 * @returns {Promise<{dispute: object, ratingsApplied: boolean}>}
 */
export async function raiseDispute({ matchId, uid, body }) {
  const db = getFirestore();

  return db.runTransaction(async (tx) => {
    const matchRef = db.collection(MATCHES_COLLECTION).doc(matchId);
    const snap = await tx.get(matchRef);

    if (!snap.exists) throw httpError(404, 'Not Found', 'no such match');

    const match = { id: snap.id, ...snap.data() };

    if (!playersOf(match).includes(uid)) {
      throw httpError(403, 'Forbidden', 'You can only dispute a match you played in.');
    }

    const live = await tx.get(
      db
        .collection(DISPUTES_COLLECTION)
        .where('matchId', '==', matchId)
        .where('status', 'in', LIVE)
        .limit(1),
    );

    if (!live.empty) {
      throw Object.assign(
        httpError(409, 'Conflict', 'this match already has an open dispute'),
        { existingDisputeId: live.docs[0].id },
      );
    }

    // The whole decision turns on this one fact.
    const ratingsApplied = match.status === STATUS.CONFIRMED;

    const now = new Date().toISOString();
    const disputeRef = db.collection(DISPUTES_COLLECTION).doc();

    tx.create(disputeRef, {
      matchId,
      raisedBy: uid,
      reason: body.reason.trim(),
      evidenceUrl: body.evidenceUrl ?? null,
      // What the match looked like when the dispute was raised. Frozen, like
      // pairingType: it is the record of what the dispute was actually about,
      // and re-deriving it later from a match that has since moved on would
      // describe a different dispute.
      matchStatusAtDispute: match.status,
      ratingsApplied,
      status: ratingsApplied ? DISPUTE_STATUS.NEEDS_ADMIN_REVIEW : DISPUTE_STATUS.OPEN,
      createdAt: now,
    });

    if (ratingsApplied) {
      // -------------------------------------------------------------------
      // DO NOT REVERSE, AND DO NOT UNCONFIRM. Flag it and stop.
      //
      // Reversing has knock-on effects on every rating computed after it: each
      // of the four players has since played matches whose deltas were computed
      // against the rating this match produced. Undoing it correctly means
      // replaying everything downstream; undoing it naively means subtracting a
      // delta from a rating that is no longer the one it was added to.
      //
      // The status ALSO stays `confirmed`, which looks wrong and is not. Both
      // `M_repeat` and `hasPlayedTogether` query `status == confirmed`. Flipping
      // a rated match to `disputed` would silently drop it out of those counts,
      // so future matches between these players would be scored as more novel
      // than they are — the past deltas would stay applied while the history
      // that explains them quietly vanished. That is a worse corruption than the
      // dispute itself, and an invisible one.
      //
      // So: the rating stands, the history stays intact, and a human decides.
      // -------------------------------------------------------------------
      tx.update(matchRef, { hasOpenDispute: true });
    } else {
      // Never rated, and now never will be: confirmationService only rates a
      // match whose status is `pending`.
      tx.update(matchRef, { status: STATUS.DISPUTED, hasOpenDispute: true });
    }

    return {
      dispute: {
        id: disputeRef.id,
        matchId,
        raisedBy: uid,
        status: ratingsApplied ? DISPUTE_STATUS.NEEDS_ADMIN_REVIEW : DISPUTE_STATUS.OPEN,
        createdAt: now,
      },
      ratingsApplied,
    };
  });
}

// ---------------------------------------------------------------------------
// Admin queue (Step 15)
// ---------------------------------------------------------------------------

/** How an admin may close a dispute. */
export const RESOLUTION = Object.freeze({
  /** No wrongdoing found. The match stands; the flag clears. */
  DISMISS: 'dismiss',
  /** Wrongdoing found on a NEVER-RATED match: void it so it stays unratable. */
  VOID: 'void',
});

const RESOLVE_MIN_NOTE = 5;

export function validateResolve(body) {
  const b = body ?? {};
  const allowed = ['action', 'note'];
  const rejected = Object.keys(b).filter((k) => !allowed.includes(k));
  const errors = [];

  if (!Object.values(RESOLUTION).includes(b.action)) {
    errors.push(`action must be one of: ${Object.values(RESOLUTION).join(', ')}.`);
  }
  if (typeof b.note !== 'string' || b.note.trim().length < RESOLVE_MIN_NOTE) {
    errors.push(`note must be a string of at least ${RESOLVE_MIN_NOTE} characters.`);
  }

  return { rejected, errors };
}

function disputeQueueView(dispute, match) {
  return {
    id: dispute.id,
    matchId: dispute.matchId,
    raisedBy: dispute.raisedBy,
    reason: dispute.reason,
    evidenceUrl: dispute.evidenceUrl ?? null,
    status: dispute.status,
    ratingsApplied: dispute.ratingsApplied === true,
    matchStatusAtDispute: dispute.matchStatusAtDispute ?? null,
    createdAt: dispute.createdAt,
    // Match context so the admin can judge without a second request. Null if the
    // match was hard-deleted, which should not happen but must not crash the queue.
    match: match
      ? {
          id: match.id,
          teamA: match.teamA,
          teamB: match.teamB,
          sets: match.sets,
          winner: match.winner,
          playedAt: match.playedAt,
          status: match.status,
        }
      : null,
  };
}

/**
 * The live dispute queue, each entry joined to its match for context.
 *
 * @returns {Promise<object[]>} newest first.
 */
export async function listQueue() {
  const db = getFirestore();

  // status `in` LIVE + orderBy createdAt would need a composite index for a
  // handful of rows; fetch the small disputes collection and filter in memory.
  const snap = await db.collection(DISPUTES_COLLECTION).get();
  const live = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => LIVE.includes(d.status))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return Promise.all(
    live.map(async (dispute) => {
      const matchSnap = await db.collection(MATCHES_COLLECTION).doc(dispute.matchId).get();
      const match = matchSnap.exists ? { id: matchSnap.id, ...matchSnap.data() } : null;
      return disputeQueueView(dispute, match);
    }),
  );
}

/**
 * Resolve a dispute — record the human decision and close it.
 *
 * This NEVER reverses an applied rating. For a rated match the correct response
 * is to record the decision and clear the flag; any rating correction is a
 * separate, deliberate manual action, because an automatic reversal cascades
 * into every rating computed after it. See CLAUDE.md > Disputes. For a
 * never-rated match, `void` sets it to `rejected` so it can never be rated.
 *
 * @param {{disputeId: string, uid: string, body: {action: string, note: string}}} input
 */
export async function resolveDispute({ disputeId, uid, body }) {
  const db = getFirestore();

  return db.runTransaction(async (tx) => {
    const disputeRef = db.collection(DISPUTES_COLLECTION).doc(disputeId);
    const snap = await tx.get(disputeRef);
    if (!snap.exists) throw httpError(404, 'Not Found', 'no such dispute');

    const dispute = { id: snap.id, ...snap.data() };
    if (dispute.status === DISPUTE_STATUS.RESOLVED) {
      throw httpError(409, 'Conflict', 'this dispute is already resolved');
    }

    const matchRef = db.collection(MATCHES_COLLECTION).doc(dispute.matchId);
    const matchSnap = await tx.get(matchRef);
    const match = matchSnap.exists ? { id: matchSnap.id, ...matchSnap.data() } : null;

    const now = new Date().toISOString();

    tx.update(disputeRef, {
      status: DISPUTE_STATUS.RESOLVED,
      resolution: body.action,
      resolutionNote: body.note.trim(),
      resolvedBy: uid,
      resolvedAt: now,
    });

    if (match) {
      const patch = { hasOpenDispute: false };
      // Void only bites a match that never affected ratings. A rated match keeps
      // its status and its deltas; reversal is a separate manual step.
      if (body.action === RESOLUTION.VOID && !dispute.ratingsApplied) {
        patch.status = STATUS.REJECTED;
      }
      tx.update(matchRef, patch);
    }

    return {
      dispute: { id: dispute.id, status: DISPUTE_STATUS.RESOLVED, resolution: body.action, resolvedBy: uid, resolvedAt: now },
      ratingReversalRequiredManually: body.action === RESOLUTION.VOID && dispute.ratingsApplied === true,
    };
  });
}
