/**
 * The API surface, one method per endpoint the backend actually serves.
 *
 * Deliberately NOT a generic `request()` export. If a screen needs a call that
 * is not here, the answer is a backend endpoint plus a method here — not an
 * ad-hoc fetch. That keeps the client from inventing routes the API does not
 * have, and keeps every request's shape reviewable in one file.
 *
 * The backend allowlists request bodies and returns 400 naming any field the
 * client may not set, so these methods pass through only documented fields.
 */
import { request } from './client.js';

export { ApiError } from './ApiError.js';
export { setTokenProvider } from './client.js';

// --- Users -----------------------------------------------------------------

/**
 * First-time signup. Requires a verified Firebase token but no existing profile
 * — it is the one endpoint reachable in that state.
 *
 * `inviteCode` gates signup only while the community is in a soft-launch
 * window — the backend checks whether any invite code is currently active
 * and only then requires a valid one. Harmless to send even when nothing is
 * gated; the server ignores it in that case.
 *
 * @param {{name: string, gender: 'M'|'F', photoUrl?: string|null, area?: string|null, inviteCode?: string}} profile
 */
export function createUser(profile) {
  return request('/users', { method: 'POST', body: profile });
}

/** The signed-in player's own profile. 403 with `isMissingProfile` if none yet. */
export function getMe() {
  return request('/users/me');
}

/**
 * Update your own profile. Only name, photoUrl and area — gender is admin-only
 * (mutable, but it moves you between leaderboards, so it wants a human check).
 *
 * @param {{name?: string, photoUrl?: string|null, area?: string|null}} patch
 */
export function patchMe(patch) {
  return request('/users/me', { method: 'PATCH', body: patch });
}

/**
 * Upload a new profile photo. `file` is a browser File/Blob, typically from
 * an `<input type="file">`. The server validates type (JPEG/PNG/WebP) and
 * size (5MB), uploads it, and writes the resulting URL to `photoUrl` — the
 * response is the caller's full updated self-view, same shape as getMe().
 *
 * Sent as multipart form data, not JSON — see client.js's `request` for why
 * that means no explicit Content-Type here.
 *
 * @param {File|Blob} file
 */
export function uploadPhoto(file) {
  const form = new FormData();
  form.append('photo', file);
  return request('/users/me/photo', { method: 'POST', body: form });
}

/**
 * Remove your profile photo. Deletes the stored file server-side and clears
 * `photoUrl` back to null — the response is the caller's full updated
 * self-view, same shape as getMe().
 */
export function deletePhoto() {
  return request('/users/me/photo', { method: 'DELETE' });
}

/**
 * Matches awaiting the caller's confirmation — Home's highest-priority section.
 *
 * @returns {Promise<{matches: object[], players: Record<string,string>,
 *   courts: Record<string,string>}>} match views plus name lookups, since match
 *   documents store uids and the cards show names.
 */
export function getPendingMatches() {
  return request('/matches/pending');
}

/**
 * The caller's recent rated (confirmed) matches, newest first.
 *
 * @param {{limit?: number}} [options]
 * @returns {Promise<{matches: object[], players: Record<string,string>,
 *   courts: Record<string,string>}>}
 */
export function getRecentMatches(options = {}) {
  return request('/matches/recent', { query: { limit: options.limit } });
}

/**
 * One match in full, for the Confirm screen. Participants only (403 otherwise).
 *
 * @returns {Promise<{match: object, players: Record<string,string>,
 *   courts: Record<string,string>}>} the match carries `viewerNeedsToConfirm`.
 */
export function getMatch(matchId) {
  return request(`/matches/${encodeURIComponent(matchId)}`);
}

/** Player search by name prefix. Returns public fields only. */
export function searchUsers(q) {
  return request('/users/search', { query: { q } });
}

/**
 * Another player's profile — reached from the leaderboard. Richer than
 * search's public fields (adds gender, tier, games played, member-since), but
 * still never rating internals. 404 if the player doesn't exist.
 */
export function getUserProfile(id) {
  return request(`/users/${encodeURIComponent(id)}`);
}

/**
 * Another player's recent rated matches, newest first — same shape as
 * getRecentMatches, scoped to `id` instead of the caller.
 *
 * @param {{limit?: number}} [options]
 */
export function getUserMatches(id, options = {}) {
  return request(`/users/${encodeURIComponent(id)}/matches`, {
    query: { limit: options.limit },
  });
}

// --- Courts ----------------------------------------------------------------

/** @param {{area?: string, search?: string}} [filters] */
export function listCourts(filters = {}) {
  return request('/courts', { query: { area: filters.area, search: filters.search } });
}

// --- Matches ---------------------------------------------------------------

/**
 * A fresh idempotency key. Call this ONCE per submit action and reuse it across
 * retries of that same action.
 *
 * Do not call it inside a retry loop: a new key on retry is a new match, which
 * is exactly the double-submit this mechanism exists to prevent. The server
 * derives the match document id from this key, so resending the same key returns
 * the match already created rather than creating a second one.
 */
export function newIdempotencyKey() {
  return crypto.randomUUID();
}

/**
 * Report a match. Created `pending`; it affects no rating until one player from
 * EACH team has confirmed.
 *
 * `idempotencyKey` is required and is the CALLER's to own — see
 * `newIdempotencyKey`. It is not generated here on purpose: generating it inside
 * this function would mint a new key on every retry and defeat the guard.
 *
 * Note there is no `format` field. The server derives the format from the number
 * of sets; sending one is a 400, because a client-selectable multiplier would be
 * a way to game the rating.
 *
 * @param {{courtId: string, teamA: string[], teamB: string[],
 *          sets: {teamA: number, teamB: number}[], playedAt: string,
 *          idempotencyKey: string}} match
 */
export async function createMatch(match) {
  // async so this REJECTS rather than throwing synchronously — every other
  // method returns a promise, and a caller using .catch() should not have one
  // failure mode escape past it.
  if (!match?.idempotencyKey) {
    throw new Error(
      'createMatch requires an idempotencyKey — call newIdempotencyKey() once ' +
        'per submit action and reuse it across retries.',
    );
  }
  return request('/matches', { method: 'POST', body: match });
}

/**
 * Confirm a match you played in.
 *
 * The response carries `ratingApplied`: true only on the confirmation that
 * completed the one-per-team rule and actually ran the rating pipeline. A repeat
 * confirmation is a no-op that returns the match, not an error.
 */
export function confirmMatch(matchId) {
  return request(`/matches/${encodeURIComponent(matchId)}/confirm`, { method: 'POST' });
}

/**
 * Dispute a match you played in.
 *
 * The response carries `ratingsApplied`, which the UI must respect: if the match
 * had already been rated, the ratings STAND and an admin reviews it — nothing is
 * reversed. Telling the player otherwise would be a lie.
 *
 * @param {string} matchId
 * @param {{reason: string, evidenceUrl?: string|null}} dispute `reason` needs at
 *   least 10 characters; `evidenceUrl` must be an http(s) URL (upload the photo
 *   first, then send its URL).
 */
export function disputeMatch(matchId, dispute) {
  return request(`/matches/${encodeURIComponent(matchId)}/dispute`, {
    method: 'POST',
    body: dispute,
  });
}

// --- Feedback --------------------------------------------------------------

/**
 * Sportsmanship feedback for the other three players in a match.
 *
 * Sportsmanship only — this never touches anyone's skill rating. `ratings` must
 * cover exactly the other three players, scored 1-5.
 *
 * @param {{matchId: string, ratings: Record<string, number>}} feedback
 */
export function submitFeedback(feedback) {
  return request('/feedback', { method: 'POST', body: feedback });
}

// --- Leaderboard -----------------------------------------------------------

/**
 * @param {{pool?: 'men'|'women'|'open', area?: string, period?: '7d'|'30d'|'all'}} [options]
 *   `period` sets the window for the movement indicator only — it does not
 *   change who appears or how they rank. There is no mixed pool.
 */
export function getLeaderboard(options = {}) {
  return request('/leaderboard', {
    query: { pool: options.pool, area: options.area, period: options.period },
  });
}
