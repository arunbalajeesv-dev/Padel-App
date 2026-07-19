/**
 * The four states an app session can be in.
 *
 * Kept out of AuthContext.jsx so that file exports only components — React Fast
 * Refresh cannot hot-reload a module that mixes components with other exports.
 */
export const STATUS = Object.freeze({
  LOADING: 'loading',
  /** No Firebase user. */
  SIGNED_OUT: 'signedOut',
  /** Phone verified, but no profile document in our backend yet. */
  NEEDS_PROFILE: 'needsProfile',
  /** Verified and has a profile — full access. */
  READY: 'ready',
});
