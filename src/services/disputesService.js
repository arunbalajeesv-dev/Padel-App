/**
 * Disputes.
 *
 * A dispute says "this match did not happen as reported". It can ONLY be
 * raised against a `pending` match — one that has not been confirmed yet.
 *
 * ---------------------------------------------------------------------------
 * A DISPUTE CANNOT BE RAISED ONCE A MATCH IS CONFIRMED
 *
 * Both-team confirmation IS the community's trust checkpoint (see CLAUDE.md >
 * Anti-Abuse Rules — it is the load-bearing anti-collusion defence). Once a
 * match has one confirmation from each team, that checkpoint has been passed
 * and the result is final. This is a deliberate line, not a limitation to
 * work around: the alternative — allowing a dispute after ratings have
 * already been applied — requires either reversing an applied rating (which
 * cascades into every match those four players played afterward, and every
 * player downstream of THEM) or leaving the ratings standing while a dispute
 * sits open with no clean resolution. Closing the door at confirmation avoids
 * both problems by construction: nothing is ever disputed once it has already
 * moved a rating.
 *
 * So the only match states a dispute ever touches are `pending` (before
 * confirmation) and, once raised, `disputed` (blocked, awaiting an admin).
 * ---------------------------------------------------------------------------
 */
import { getFirestore } from '../config/firebase.js';
import { MATCHES_COLLECTION, STATUS, playersOf, resolveNames } from './matchesService.js';

export const DISPUTES_COLLECTION = 'disputes';

export const DISPUTE_STATUS = Object.freeze({
  OPEN: 'open',
  RESOLVED: 'resolved',
});

/** Statuses that mean a dispute is still live, so a second one is redundant. */
const LIVE = [DISPUTE_STATUS.OPEN];

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
 * Raise a dispute against a match. Only a `pending` match is eligible — see
 * the module note for why a confirmed one is refused outright rather than
 * flagged for review.
 *
 * @param {{matchId: string, uid: string, body: object}} input
 * @returns {Promise<{dispute: object}>}
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

    // A match's status and "does it have a live dispute" are always in sync —
    // every path that opens a dispute sets status to `disputed` in the same
    // transaction, and every path that resolves one moves it to `pending` or
    // `rejected` in the same transaction. So `status !== pending` alone covers
    // every case that would otherwise need a second query: already disputed,
    // already rejected, or already confirmed. One check, one source of truth.
    if (match.status !== STATUS.PENDING) {
      const reason =
        match.status === STATUS.CONFIRMED
          ? 'This match has already been confirmed and rated — it can no longer be disputed.'
          : match.status === STATUS.DISPUTED
            ? 'This match already has an open dispute.'
            : `This match is ${match.status} and can no longer be disputed.`;
      throw httpError(409, 'Conflict', reason);
    }

    const now = new Date().toISOString();
    const disputeRef = db.collection(DISPUTES_COLLECTION).doc();

    tx.create(disputeRef, {
      matchId,
      raisedBy: uid,
      reason: body.reason.trim(),
      evidenceUrl: body.evidenceUrl ?? null,
      status: DISPUTE_STATUS.OPEN,
      createdAt: now,
    });

    // Blocked from confirmation until an admin resolves it — see resolveDispute.
    tx.update(matchRef, { status: STATUS.DISPUTED });

    return {
      dispute: {
        id: disputeRef.id,
        matchId,
        raisedBy: uid,
        status: DISPUTE_STATUS.OPEN,
        createdAt: now,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Admin queue (Step 15)
// ---------------------------------------------------------------------------

/** How an admin may close a dispute — the only two outcomes for a never-rated match. */
export const RESOLUTION = Object.freeze({
  /** No wrongdoing found. Restore to `pending` — confirmation proceeds normally. */
  APPROVE: 'approve',
  /** Wrongdoing found. Reject permanently; it can never be confirmed. */
  CANCEL: 'cancel',
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
 * @returns {Promise<{disputes: object[], players: Record<string,string>}>}
 *   `disputes` newest first. `players` resolves every uid appearing in any of
 *   them to a name, so the admin surface never has to render a raw uid.
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

  const matches = await Promise.all(
    live.map(async (dispute) => {
      const matchSnap = await db.collection(MATCHES_COLLECTION).doc(dispute.matchId).get();
      return matchSnap.exists ? { id: matchSnap.id, ...matchSnap.data() } : null;
    }),
  );

  const { players } = await resolveNames(matches.filter(Boolean));

  return {
    disputes: live.map((dispute, i) => disputeQueueView(dispute, matches[i])),
    players,
  };
}

/**
 * Resolved disputes, newest first — the admin panel's history view.
 *
 * @returns {Promise<{disputes: object[], players: Record<string,string>}>}
 */
export async function listHistory() {
  const db = getFirestore();

  const snap = await db.collection(DISPUTES_COLLECTION).get();
  const resolved = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((d) => d.status === DISPUTE_STATUS.RESOLVED)
    .sort((a, b) => String(b.resolvedAt ?? b.createdAt).localeCompare(String(a.resolvedAt ?? a.createdAt)));

  const matches = await Promise.all(
    resolved.map(async (dispute) => {
      const matchSnap = await db.collection(MATCHES_COLLECTION).doc(dispute.matchId).get();
      return matchSnap.exists ? { id: matchSnap.id, ...matchSnap.data() } : null;
    }),
  );

  const { players } = await resolveNames(matches.filter(Boolean));

  return {
    disputes: resolved.map((dispute, i) => ({
      ...disputeQueueView(dispute, matches[i]),
      resolution: dispute.resolution,
      resolutionNote: dispute.resolutionNote,
      resolvedBy: dispute.resolvedBy,
      resolvedAt: dispute.resolvedAt,
    })),
    players,
  };
}

/**
 * Resolve a dispute — record the human decision and close it.
 *
 * Since a dispute can only exist against a match that was never rated (see
 * the module note), both outcomes are clean:
 *
 *   approve — no wrongdoing. Restored to `pending`, exactly as if the dispute
 *             had never been raised; the match re-enters normal confirmation
 *             and needs a real confirmation from each team to ever rate.
 *   cancel  — wrongdoing found. Rejected permanently; it can never be rated.
 *
 * Neither touches a rating, because none was ever applied.
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

    const newMatchStatus = body.action === RESOLUTION.APPROVE ? STATUS.PENDING : STATUS.REJECTED;
    if (match) {
      tx.update(matchRef, { status: newMatchStatus });
    }

    return {
      dispute: {
        id: dispute.id,
        status: DISPUTE_STATUS.RESOLVED,
        resolution: body.action,
        resolvedBy: uid,
        resolvedAt: now,
      },
      matchStatus: match ? newMatchStatus : null,
    };
  });
}
