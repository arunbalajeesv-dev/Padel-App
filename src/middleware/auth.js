/**
 * Firebase auth middleware.
 *
 * `requireAuth` verifies the bearer token, loads the caller's user document, and
 * attaches `req.uid` and `req.user`. `requireAdmin` gates on `isAdmin` and must
 * run after it.
 */
import { getAuth, getFirestore } from '../config/firebase.js';

export const USERS_COLLECTION = 'users';

const BEARER = /^Bearer\s+(.+)$/i;

/** Firebase error codes that mean "refresh and retry", not "you are not you". */
const EXPIRED_CODES = new Set(['auth/id-token-expired', 'auth/session-cookie-expired']);

function unauthorized(res, reason) {
  return res.status(401).json({ error: 'Unauthorized', reason });
}

function forbidden(res, reason) {
  return res.status(403).json({ error: 'Forbidden', reason });
}

/**
 * Shared implementation. `profile: 'required'` 403s a uid with no user document;
 * `profile: 'optional'` allows it through with `req.user === null`.
 */
function authenticate({ profile }) {
  return async function middleware(req, res, next) {
    const match = BEARER.exec(req.get('authorization') ?? '');
    if (!match) {
      return unauthorized(res, 'missing or malformed Authorization header');
    }

    const token = match[1].trim();
    if (!token) return unauthorized(res, 'missing token');

    let decoded;
    try {
      decoded = await getAuth().verifyIdToken(token);
    } catch (err) {
      // Expired is worth distinguishing: the client can silently refresh rather
      // than dumping the user back to a login screen. It leaks nothing — the
      // caller already holds the token.
      return unauthorized(
        res,
        EXPIRED_CODES.has(err?.code) ? 'expired token' : 'invalid token',
      );
    }

    if (!decoded?.uid) return unauthorized(res, 'invalid token');

    let snap;
    try {
      snap = await getFirestore().collection(USERS_COLLECTION).doc(decoded.uid).get();
    } catch (err) {
      return next(err); // 500 — not the caller's fault, and not a 403.
    }

    if (!snap.exists && profile === 'required') {
      return forbidden(res, 'no user record for this account');
    }

    req.uid = decoded.uid;
    req.token = decoded;
    req.user = snap.exists ? { id: snap.id, ...snap.data() } : null;

    return next();
  };
}

/**
 * Verify the caller and require an existing profile. **The default.**
 *
 * - 401 — no token, malformed header, or a token Firebase rejects.
 * - 403 — token is valid but the uid has no user document. The caller is
 *   authenticated but not yet a member; the client should route to signup.
 *
 * A Firestore failure is NOT a 403. It is a server fault and must surface as a
 * 500: telling a legitimate member "you have no account" because a read timed
 * out would be a lie, and would send the client to signup for an account they
 * already have.
 */
export const requireAuth = authenticate({ profile: 'required' });

/**
 * Verify the caller but ALLOW a missing profile. `req.user` is null when the
 * uid has no document yet.
 *
 * This exists for exactly one route: **POST /users**, first-time profile
 * creation. A verified phone with no profile is precisely the state that route
 * serves — under `requireAuth` it would 403 and signup would be unreachable.
 *
 * ---------------------------------------------------------------------------
 * DO NOT MOUNT THIS ON ANYTHING ELSE.
 *
 * It is deliberately named so the exception is visible at the call site. Any
 * route using it must treat `req.user === null` as a real, expected state and
 * must not read profile fields without checking. Everything else uses
 * `requireAuth`.
 * ---------------------------------------------------------------------------
 */
export const requireVerifiedToken = authenticate({ profile: 'optional' });

/**
 * Gate on the `isAdmin` flag. Must be mounted AFTER `requireAuth`.
 *
 * If `req.user` is absent, auth did not run — that is a wiring bug, not a client
 * error. It surfaces as a 500 rather than a 403 so it is loud: a silent 403
 * would look like a working permission check and hide the fact that the route is
 * unprotected in ways that matter elsewhere.
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return next(
      new Error('requireAdmin was reached without requireAuth — check route wiring.'),
    );
  }

  if (req.user.isAdmin !== true) {
    return forbidden(res, 'admin only');
  }

  return next();
}
