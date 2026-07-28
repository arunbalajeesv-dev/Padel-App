/**
 * Matches data layer.
 *
 * A match is created `pending` and affects no rating until confirmed by at least
 * one player on EACH team. See CLAUDE.md > Anti-Abuse Rules.
 */
import { createHash } from 'node:crypto';

import { getFirestore } from '../config/firebase.js';
import { validateScore } from '../lib/scoreValidator.js';
import { USERS_COLLECTION } from './usersService.js';
import { COURTS_COLLECTION } from './courtsService.js';

export const MATCHES_COLLECTION = 'matches';

export const STATUS = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  DISPUTED: 'disputed',
  REJECTED: 'rejected',
});

/**
 * Fields a client may send. Anything else is REJECTED with a 400 — see
 * CLAUDE.md > "Request bodies are allowlisted".
 *
 * `format` is deliberately absent: it is DERIVED from the set count and never
 * accepted from the client, because a selectable multiplier is a gaming vector.
 * It is not merely ignored — a body carrying it is a 400, so a client that
 * believes it can choose the format finds out at the first request rather than
 * shipping on a false belief. `status`, `reportedBy` and `confirmedBy` are
 * likewise server-owned.
 */
export const CREATABLE_FIELDS = Object.freeze([
  'courtId',
  'teamA',
  'teamB',
  'sets',
  'playedAt',
  'idempotencyKey',
]);

const isUid = (v) => typeof v === 'string' && v.trim().length > 0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape validation. Score legality is checked separately by the validator. */
export function validateShape(body) {
  const errors = [];
  const b = body ?? {};

  if (!isUid(b.courtId)) errors.push('courtId is required.');

  for (const side of ['teamA', 'teamB']) {
    if (!Array.isArray(b[side]) || b[side].length !== 2 || !b[side].every(isUid)) {
      errors.push(`${side} must be an array of exactly two player uids.`);
    }
  }

  if (!Array.isArray(b.sets)) errors.push('sets must be an array.');

  if (!isUid(b.playedAt) || Number.isNaN(Date.parse(b.playedAt))) {
    errors.push('playedAt must be an ISO date string.');
  }

  // The UUID shape is required so that a client generating one per submit action
  // is the obvious reading. It cannot enforce that: a client reusing one fixed
  // UUID forever would see every match after its first silently replay as that
  // first match. Nothing server-side can distinguish that from a double-tap —
  // the key is the client's assertion about which action this is.
  if (!isUid(b.idempotencyKey) || !UUID_RE.test(b.idempotencyKey)) {
    errors.push('idempotencyKey must be a UUID, generated fresh per submit action.');
  }

  return errors;
}

/** Fields present in the body but outside the allowlist. */
const rejectedFields = (body) =>
  Object.keys(body ?? {}).filter((k) => !CREATABLE_FIELDS.includes(k));

/** Mirrors usersService.validateCreate: unknown fields are rejected, not stripped. */
export function validateCreate(body) {
  return {
    rejected: rejectedFields(body),
    errors: validateShape(body),
  };
}

/** All four uids, team A first. Only valid once validateShape passes. */
export const playersOf = (body) => [...body.teamA, ...body.teamB];

/**
 * Order-independent identity of a PAIR, for "have these two partnered before?".
 * Sorted, so [a,b] and [b,a] are the same pair.
 */
export const pairKey = (a, b) => [a, b].sort().join('|');

/**
 * Order-independent identity of a four-player MATCHUP, for M_repeat.
 *
 * Sorted across both teams, so the same four people are the same matchup even if
 * they swap partners. That is deliberate: M_repeat asks how much NEW information
 * a match carries, and a fifth match between the same four people tells us little
 * regardless of which two are paired.
 */
export const matchupKeyFor = (players) => [...players].sort().join('|');

export function validateDistinct(body) {
  const players = playersOf(body);
  const unique = new Set(players);

  if (unique.size !== 4) {
    return ['All four players must be distinct — a player cannot appear twice.'];
  }
  return [];
}

/**
 * Confirmation state, derived — never stored.
 *
 * A match needs at least one confirmation from EACH team. Storing this would be
 * a second source of truth that drifts from `confirmedBy`.
 */
export function confirmationState(match) {
  const confirmed = new Set(match.confirmedBy ?? []);
  const teamAConfirmed = match.teamA.some((uid) => confirmed.has(uid));
  const teamBConfirmed = match.teamB.some((uid) => confirmed.has(uid));

  return {
    teamA: {
      confirmed: teamAConfirmed,
      awaiting: teamAConfirmed ? [] : match.teamA.filter((uid) => !confirmed.has(uid)),
    },
    teamB: {
      confirmed: teamBConfirmed,
      awaiting: teamBConfirmed ? [] : match.teamB.filter((uid) => !confirmed.has(uid)),
    },
    // Any ONE player from each listed team still needs to confirm.
    isFullyConfirmed: teamAConfirmed && teamBConfirmed,
  };
}

/** Client-facing shape. Allowlist. */
export function toMatchView(match) {
  const confirmation = confirmationState(match);

  return {
    id: match.id,
    courtId: match.courtId,
    teamA: match.teamA,
    teamB: match.teamB,
    sets: match.sets,
    gamesA: match.gamesA,
    gamesB: match.gamesB,
    winner: match.winner,
    format: match.format,
    playedAt: match.playedAt,
    status: match.status,
    reportedBy: match.reportedBy,
    confirmedBy: match.confirmedBy,
    confirmation,
    // Flattened for the client: who can unblock this match right now.
    awaitingConfirmationFrom: [
      ...confirmation.teamA.awaiting,
      ...confirmation.teamB.awaiting,
    ],
    createdAt: match.createdAt,
  };
}

/**
 * Resolve the player uids and court ids across a set of matches into names, so
 * the client can render "Vikram" instead of a uid. Match documents store ids
 * only; names live on the user and court documents.
 *
 * One batched read for users and one for courts, regardless of how many matches
 * — the Home screen shows a handful, and this keeps it to two round trips.
 *
 * Exported for disputesService's admin queue, which needs the same
 * uid-to-name resolution over a different collection's documents.
 *
 * @returns {Promise<{players: Record<string,string>, courts: Record<string,string>}>}
 */
export async function resolveNames(matches) {
  const db = getFirestore();

  const playerIds = [...new Set(matches.flatMap((m) => m.players ?? []))];
  const courtIds = [...new Set(matches.map((m) => m.courtId).filter(Boolean))];

  const players = {};
  const courts = {};

  if (playerIds.length > 0) {
    const snaps = await db.getAll(...playerIds.map((id) => db.collection(USERS_COLLECTION).doc(id)));
    for (const s of snaps) if (s.exists) players[s.id] = s.data().name ?? null;
  }
  if (courtIds.length > 0) {
    const snaps = await db.getAll(...courtIds.map((id) => db.collection(COURTS_COLLECTION).doc(id)));
    for (const s of snaps) if (s.exists) courts[s.id] = s.data().name ?? null;
  }

  return { players, courts };
}

const httpError = (status, error, reason) =>
  Object.assign(new Error(reason), { status, error, reason });

/**
 * A match view tagged with the state that applies to ONE viewing player:
 * `viewerNeedsToConfirm` is true when this viewer is a participant who has not
 * confirmed yet. The card uses it to decide between the action-needed state (a
 * Confirm button) and the waiting state (no button, "waiting on the other team").
 */
function viewForPlayer(match, uid) {
  return {
    ...toMatchView(match),
    viewerNeedsToConfirm: !(match.confirmedBy ?? []).includes(uid),
  };
}

/**
 * ALL pending matches this player is part of — not only the ones awaiting their
 * own confirmation. A pending match belongs on the Home of all four players:
 * the reporter (auto-confirmed at creation) sees it as pending-on-the-other-team,
 * and anyone who still owes a confirmation sees it as action-needed. Each match
 * carries `viewerNeedsToConfirm` so the client can tell those apart WITHOUT
 * re-deriving it — and so a Confirm button is never shown to someone who already
 * confirmed.
 *
 * `players array-contains` + `status ==` is served by the automatic single-field
 * indexes (no composite needed).
 *
 * @returns {Promise<{matches: object[], players: object, courts: object}>}
 */
export async function listPendingForPlayer(uid) {
  const snap = await getFirestore()
    .collection(MATCHES_COLLECTION)
    .where('players', 'array-contains', uid)
    .where('status', '==', STATUS.PENDING)
    .get();

  const matches = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));

  const names = await resolveNames(matches);
  return { matches: matches.map((m) => viewForPlayer(m, uid)), ...names };
}

/**
 * A single match in full, for the Confirm screen. Only a participant may load
 * it — a match record is not public. Tagged with the viewer's state and joined
 * to player and court names.
 *
 * @throws {Error & {status}} 404 if unknown, 403 if the caller did not play.
 * @returns {Promise<{match: object, players: object, courts: object}>}
 */
export async function getMatchForPlayer(uid, matchId) {
  const match = await findById(matchId);
  if (!match) throw httpError(404, 'Not Found', 'no such match');

  const players = match.players ?? playersOf(match);
  if (!players.includes(uid)) {
    throw httpError(403, 'Forbidden', 'You can only view a match you played in.');
  }

  const names = await resolveNames([match]);
  return { match: viewForPlayer(match, uid), ...names };
}

/**
 * This player's recent RATED matches, newest first. Confirmed only — a pending
 * match belongs in the "waiting on you" section, not recent activity.
 *
 * Sorted in memory to avoid an array-contains + orderBy composite index; a
 * player's confirmed-match count is small enough that fetching and slicing is
 * cheaper than maintaining another index.
 *
 * @returns {Promise<{matches: object[], players: object, courts: object}>}
 */
export async function listRecentForPlayer(uid, { limit = 10 } = {}) {
  const snap = await getFirestore()
    .collection(MATCHES_COLLECTION)
    .where('players', 'array-contains', uid)
    .where('status', '==', STATUS.CONFIRMED)
    .get();

  const matches = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)))
    .slice(0, limit);

  const names = await resolveNames(matches);
  return { matches: matches.map(toMatchView), ...names };
}

export async function findById(id) {
  const snap = await getFirestore().collection(MATCHES_COLLECTION).doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * The document id a submission claims, derived from the reporter and their key.
 *
 * Deriving the id rather than querying for the key is what makes the guard
 * ATOMIC: `create()` throws ALREADY_EXISTS, so two double-tapped requests in
 * flight at once cannot both pass a read-then-write check. A double-tap arrives
 * milliseconds apart, so that race is the expected case, not a corner.
 *
 * The reporter's uid is hashed in so that a client cannot choose another
 * player's match id. Were the key the id alone, a caller could submit with a key
 * they know is in use and receive the existing match back — reading a match they
 * may not be in. Hashing scopes every key to its own reporter.
 */
export function matchDocId(reporterUid, idempotencyKey) {
  return createHash('sha256').update(`${reporterUid}:${idempotencyKey}`).digest('hex');
}

/**
 * Create a pending match, or return the one this key already created.
 *
 * `format` and `winner` come from the VALIDATED score, never the body. The
 * caller is recorded as reporter and counts as their own team's confirmation —
 * the match still needs one from the other team before it touches any rating.
 *
 * A repeat of a key returns the STORED match, even if the body differs. The key
 * names the submit action; if the body changed under a reused key, the client
 * has a bug, and honouring the second body would be creating a match the key
 * says already exists.
 *
 * @returns {Promise<{ match: object, created: boolean }>} created is false on a
 *   replay, which the route reports as 200 rather than 201.
 */
export async function createMatch({ body, reporterUid, validated }) {
  const players = playersOf(body);
  const id = matchDocId(reporterUid, body.idempotencyKey);

  const doc = {
    courtId: body.courtId,
    teamA: [...body.teamA],
    teamB: [...body.teamB],
    // Denormalised for querying; Firestore cannot search across two arrays.
    players,
    // Also denormalised, and for the same reason: confirmation needs "have these
    // two partnered before?" and "how many identical matchups this week?", and
    // neither is answerable from `players` without reading every match.
    pairs: [pairKey(...body.teamA), pairKey(...body.teamB)],
    matchupKey: matchupKeyFor(players),
    sets: body.sets,

    // Derived from the score. A client-supplied format is never read.
    format: validated.format,
    winner: validated.winner,
    gamesA: validated.gamesA,
    gamesB: validated.gamesB,

    playedAt: body.playedAt,
    status: STATUS.PENDING,
    reportedBy: reporterUid,
    confirmedBy: [reporterUid],
    // Stored so the guard is visible in the data, not only in the id derivation.
    idempotencyKey: body.idempotencyKey,
    createdAt: new Date().toISOString(),
  };

  const ref = getFirestore().collection(MATCHES_COLLECTION).doc(id);

  try {
    // create() throws rather than overwriting — the same reasoning as signup:
    // a resend must not clobber a match that has since collected confirmations.
    await ref.create(doc);
    return { match: { id, ...doc }, created: true };
  } catch (err) {
    if (err?.code === 6 || err?.code === 'already-exists') {
      const existing = await findById(id);
      if (existing) return { match: existing, created: false };
    }
    throw err;
  }
}

/** Re-export so routes validate through one path. */
export { validateScore };
