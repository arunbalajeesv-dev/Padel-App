/**
 * Users data layer.
 *
 * Users are keyed by Firebase uid: the document id IS the uid. That is what
 * enforces one account per phone number — Firebase phone auth issues one uid per
 * number, so a second signup with the same phone lands on the same document.
 */
import { getFirestore } from '../config/firebase.js';
import { toDisplayRating } from '../lib/displayRating.js';
import { TIER, placementCountdown } from '../lib/placement.js';

export const USERS_COLLECTION = 'users';

/** Sorts above any ordinary character — the upper bound of a prefix range. */
const HIGH_SENTINEL = '';

/**
 * Fields a client may set at signup. Anything else in the body is rejected.
 *
 * This is an ALLOWLIST, deliberately. A denylist ("reject rating, status,
 * trustScore, isAdmin") leaks every field added after it is written — the next
 * privileged field someone adds would be client-settable until a human
 * remembered to update the list.
 */
export const CREATABLE_FIELDS = Object.freeze(['name', 'photoUrl', 'gender', 'area']);

/**
 * Recognized at signup but NEVER stored on the profile — `inviteCode` gates
 * whether the request is allowed through at all (see inviteCodesService.js
 * and signupRouter), it is not a durable field. Kept separate from
 * CREATABLE_FIELDS so createUser's field-copy loop can never pick it up.
 */
export const SIGNUP_ONLY_FIELDS = Object.freeze(['inviteCode']);

/** Fields a player may change on their own profile. */
export const PATCHABLE_FIELDS = Object.freeze(['name', 'photoUrl', 'area']);

/**
 * Fields an ADMIN may change on any profile.
 *
 * `gender` is here rather than in PATCHABLE_FIELDS — mutable, but not
 * self-serve.
 *
 * **Why it is safe to change at all:** `pairingType` is frozen on every match
 * document as an audit record and is never recomputed. Changing gender therefore
 * cannot rewrite the basis of matches already played. What it does do is:
 * past matches unaffected, future matches use the new value, and the player
 * moves to the correct leaderboard — which is the desired outcome, not
 * corruption. The audit record is precisely what makes this safe.
 *
 * **Why it must be mutable:** a player who mis-taps at signup would otherwise be
 * on the wrong leaderboard permanently, with no recourse — one account per phone
 * forbids making a new one. That is an unresolvable support ticket. The same
 * applies to a trans player, where "your gender is immutable" is not something
 * this app should say to a member of a 100-person community.
 *
 * **Why admin-gated rather than self-serve:** nothing malicious is invited by
 * self-serve — gender confers no rating advantage, since every leaderboard reads
 * the same latent scale. But admin-gating gives a log and a human check, which is
 * proportionate for a field that changes which board someone appears on.
 */
export const ADMIN_PATCHABLE_FIELDS = Object.freeze([...PATCHABLE_FIELDS, 'gender']);

const GENDERS = Object.freeze(['M', 'F']);

/**
 * Strip a user document to what its OWNER may see.
 *
 * Allowlist, not denylist. `rating.value`, `rating.rd`, `rating.sigma` and
 * `trustScore` never appear in any client-facing response — only ratingDisplay
 * and status. See CLAUDE.md: all rating math is server-side and never exposed.
 *
 * `isAdmin` DOES appear here — it did not always. Knowing your own admin flag
 * is not a security leak (the actual gate is `requireAdmin`, checked
 * server-side on every admin request regardless of what the client believes);
 * it was excluded only because nothing consumed it. The admin panel now does,
 * to decide whether to show its own entry point at all. It must still never
 * appear in `toPublicView`/`toPlayerView` — seeing WHO ELSE is an admin is a
 * real information leak (a map of who to target), unlike seeing your own flag.
 */
export function toSelfView(user, config) {
  return {
    id: user.id,
    phone: user.phone,
    name: user.name,
    photoUrl: user.photoUrl ?? null,
    gender: user.gender,
    area: user.area ?? null,
    ratingDisplay: toDisplayRating(user.rating.value, config),
    status: user.status,
    gamesPlayed: user.gamesPlayed,
    isAnchor: user.isAnchor === true,
    isAdmin: user.isAdmin === true,
    // The leaderboard countdown, computed server-side so the client never has to
    // reason about RD. `status` is 'visible' | 'counting' | 'settling', and
    // `matchesRemaining` is a number ONLY in the counting state — never an
    // estimate. RD itself is never exposed. See placementCountdown.
    placement: placementCountdown(
      { rd: user.rating.rd, gamesPlayed: user.gamesPlayed },
      config,
    ),
    createdAt: user.createdAt,
    lastActiveAt: user.lastActiveAt,
  };
}

/**
 * Strip a user document to what ANOTHER player may see.
 *
 * Search results expose name, photoUrl, area and ratingDisplay only — never
 * phone, never internal rating state.
 */
export function toPublicView(user, config) {
  return {
    id: user.id,
    name: user.name,
    photoUrl: user.photoUrl ?? null,
    area: user.area ?? null,
    ratingDisplay: toDisplayRating(user.rating.value, config),
  };
}

/**
 * Strip a user document to what ANOTHER player may see on a profile screen —
 * richer than toPublicView (a deliberate look-up, not a quick-pick search
 * result), but still an allowlist. Phone, rating internals (`value`, `rd`,
 * `sigma`), trustScore, isAdmin and isAnchor never appear here, same as
 * toPublicView. No placement countdown either — that copy is written in the
 * first person ("N more matches to appear on the leaderboard") and would read
 * as nonsense pointed at someone else; it also cannot apply to a player found
 * via the leaderboard, since placement players never appear there.
 */
export function toPlayerView(user, config) {
  return {
    id: user.id,
    name: user.name,
    photoUrl: user.photoUrl ?? null,
    gender: user.gender,
    area: user.area ?? null,
    ratingDisplay: toDisplayRating(user.rating.value, config),
    status: user.status,
    gamesPlayed: user.gamesPlayed,
    createdAt: user.createdAt,
  };
}

/** Validation shared by create and patch. Returns an array of messages. */
function validateProfile(input, { partial }) {
  const errors = [];
  const has = (k) => Object.hasOwn(input, k);

  if (!partial || has('name')) {
    if (typeof input.name !== 'string' || input.name.trim().length < 2) {
      errors.push('name must be a string of at least 2 characters.');
    } else if (input.name.length > 60) {
      errors.push('name must be 60 characters or fewer.');
    }
  }

  if (!partial || has('gender')) {
    if (!GENDERS.includes(input.gender)) {
      errors.push(`gender must be one of: ${GENDERS.join(', ')}.`);
    }
  }

  for (const field of ['photoUrl', 'area']) {
    if (has(field) && input[field] !== null && typeof input[field] !== 'string') {
      errors.push(`${field} must be a string or null.`);
    }
  }

  return errors;
}

/** Fields present in the body but outside the allowlist. */
function rejectedFields(body, allowed) {
  return Object.keys(body ?? {}).filter((k) => !allowed.includes(k));
}

export function validateCreate(body) {
  return {
    // inviteCode is allowed through here (so a legitimate signup body isn't
    // rejected as "unknown field") — whether it's actually REQUIRED depends on
    // runtime state (any active invite codes right now?) and is checked
    // separately in signupRouter, not here. See SIGNUP_ONLY_FIELDS.
    rejected: rejectedFields(body, [...CREATABLE_FIELDS, ...SIGNUP_ONLY_FIELDS]),
    errors: validateProfile(body ?? {}, { partial: false }),
  };
}

/**
 * @param {object} body
 * @param {{ asAdmin?: boolean }} [options] Admins may additionally set gender.
 */
export function validatePatch(body, { asAdmin = false } = {}) {
  const allowed = asAdmin ? ADMIN_PATCHABLE_FIELDS : PATCHABLE_FIELDS;
  const rejected = rejectedFields(body, allowed);
  const errors = validateProfile(body ?? {}, { partial: true });
  if (Object.keys(body ?? {}).length === 0) errors.push('No fields to update.');
  return { rejected, errors };
}

export async function findById(uid) {
  const snap = await getFirestore().collection(USERS_COLLECTION).doc(uid).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Create a first-time profile.
 *
 * Every privileged field is set HERE, by the server. Nothing the client sent can
 * reach rating, status, isAdmin, gamesPlayed or isAnchor — `input` is filtered to
 * CREATABLE_FIELDS before it is spread, so an unknown key cannot ride along even
 * if validation were bypassed.
 *
 * There is deliberately NO `trustScore` field. trustScore is derived on read from
 * `trustLogs` and is never stored — a stored copy would be a stale-derived-field
 * trap: 0 is not a value the formula can even return, so a future read of
 * `user.trustScore` would get 0 and mistake it for a real low-trust signal. See
 * CLAUDE.md > Peer Feedback.
 *
 * @param {string} uid From the verified token, never the body.
 * @param {string|null} phone From the verified token, never the body.
 */
export async function createUser({ uid, phone, input, config }) {
  const now = new Date().toISOString();

  const profile = {};
  for (const field of CREATABLE_FIELDS) {
    if (Object.hasOwn(input, field)) profile[field] = input[field];
  }

  const doc = {
    ...profile,
    // Lowercased+trimmed copy of the name, stored so search can be
    // case-insensitive. Firestore range queries are case-SENSITIVE, so a search
    // for "arun" cannot match a stored "Arun" without a folded field to match
    // against. See searchUsers and scripts/backfillNameLower.js.
    nameLower: String(profile.name ?? '').trim().toLowerCase(),
    // Identity comes from the token. A client-supplied phone would break the
    // one-account-per-number rule.
    phone: phone ?? null,
    photoUrl: profile.photoUrl ?? null,
    area: profile.area ?? null,

    // Server-owned. Every new player starts identically — there is no
    // self-assessment and no onboarding skill question.
    rating: {
      value: config.defaultRating,
      rd: config.defaultRd,
      sigma: config.defaultVolatility,
    },
    status: TIER.PLACEMENT,
    gamesPlayed: 0,
    isAnchor: false,
    isAdmin: false,
    // No trustScore: it is derived on read from trustLogs, never stored.
    createdAt: now,
    lastActiveAt: now,
  };

  // create() throws ALREADY_EXISTS rather than overwriting — a double signup
  // must not reset an existing player's rating to 1500.
  await getFirestore().collection(USERS_COLLECTION).doc(uid).create(doc);
  return { id: uid, ...doc };
}

/**
 * Apply a patch, filtered to an explicit allowlist.
 *
 * @param {string} uid
 * @param {object} input
 * @param {{ asAdmin?: boolean }} [options]
 */
export async function updateUser(uid, input, { asAdmin = false } = {}) {
  const allowed = asAdmin ? ADMIN_PATCHABLE_FIELDS : PATCHABLE_FIELDS;

  const patch = {};
  for (const field of allowed) {
    if (Object.hasOwn(input, field)) patch[field] = input[field];
  }
  patch.lastActiveAt = new Date().toISOString();

  await getFirestore().collection(USERS_COLLECTION).doc(uid).update(patch);
  return findById(uid);
}

/**
 * Set or unset a player's anchor flag. Admin-only, and deliberately NOT routed
 * through updateUser's allowlist: `isAnchor` is server-owned and has exactly one
 * writer, this function. An anchor is a trusted reference player; the flag is
 * operational, never client-settable.
 *
 * @param {string} uid
 * @param {boolean} isAnchor
 * @returns {Promise<object|null>} the updated user, or null if no such user.
 */
export async function setAnchor(uid, isAnchor) {
  const ref = getFirestore().collection(USERS_COLLECTION).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return null;

  await ref.update({ isAnchor: isAnchor === true, lastActiveAt: new Date().toISOString() });
  return findById(uid);
}

/**
 * Search players by name prefix, CASE-INSENSITIVELY.
 *
 * Firestore has no substring search and its range queries are case-sensitive, so
 * we match against `nameLower` (the folded name written by createUser). The query
 * is lowercased+trimmed the same way, then run as a prefix range [q, q +
 * HIGH_SENTINEL]. `endAt(q)` alone would match only an exact name.
 *
 * This orders and ranges on the SINGLE field `nameLower`, which Firestore serves
 * from its automatic single-field index — NO composite index is required.
 *
 * Existing users need `nameLower` backfilled once (scripts/backfillNameLower.js);
 * a user without it simply will not appear in search until backfilled. Good
 * enough for ~100 players; revisit if the club grows.
 */
export async function searchUsers(query, { limit = 20 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (q.length === 0) return [];

  const snap = await getFirestore()
    .collection(USERS_COLLECTION)
    .orderBy('nameLower')
    .startAt(q)
    .endAt(q + HIGH_SENTINEL)
    .limit(limit)
    .get();

  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
