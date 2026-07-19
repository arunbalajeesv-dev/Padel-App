/**
 * A failed API call, carrying enough for a screen to react precisely.
 *
 * Screens must be able to tell a 401 from a 400 from a 409 — they mean entirely
 * different things here:
 *
 *   400  the request was malformed or carried a field the client may not set
 *   401  the token is missing, invalid, or expired (see `isExpiredToken`)
 *   403  authenticated, but not allowed — or, on getMe, no profile yet
 *   404  no such match / court / user
 *   409  a conflict the user can act on: already confirmed, already disputed,
 *        already rated this match, duplicate signup
 *
 * The backend's error bodies are not uniform — validation failures return
 * `{ error, errors: [...] }`, rejected fields return `{ error, reason, rejected }`,
 * and state conflicts return `{ error, reason }`. All three are preserved rather
 * than flattened, so a screen can show field errors as a list and a conflict as a
 * sentence.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status.
   * @param {object|null} body Parsed JSON error body, if there was one.
   * @param {string} path Request path, for logs.
   */
  constructor(status, body, path) {
    super(ApiError.messageFrom(status, body, path));
    this.name = 'ApiError';
    this.status = status;
    this.body = body ?? null;
    this.path = path;

    /** Field-level validation messages, when the backend sent a list. */
    this.errors = Array.isArray(body?.errors) ? body.errors : [];
    /** Field names the client was not allowed to set. */
    this.rejected = Array.isArray(body?.rejected) ? body.rejected : [];
    /** The backend's one-line explanation, when it sent one. */
    this.reason = typeof body?.reason === 'string' ? body.reason : null;
  }

  static messageFrom(status, body, path) {
    const detail =
      body?.reason ||
      (Array.isArray(body?.errors) && body.errors[0]) ||
      body?.error ||
      'request failed';
    return `${status} ${detail} (${path})`;
  }

  /**
   * The token expired rather than being invalid.
   *
   * The backend distinguishes these deliberately so the client can refresh
   * silently instead of dumping a signed-in player back to a login screen.
   */
  get isExpiredToken() {
    return this.status === 401 && this.reason === 'expired token';
  }

  /**
   * Authenticated, but this account has no profile document yet.
   *
   * This is the signal to route to profile setup, NOT an error to show. It is
   * the expected state between finishing phone OTP and completing signup.
   */
  get isMissingProfile() {
    return this.status === 403 && this.reason === 'no user record for this account';
  }
}
