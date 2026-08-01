/**
 * The invite code a newcomer entered before phone auth, held until profile
 * creation needs it.
 *
 * `sessionStorage`, not React state: the flow crosses a Firebase auth state
 * change (SignIn unmounts, AuthProvider routes to ProfileSetup), and on some
 * devices the reCAPTCHA/OTP round trip can reload the page outright. State
 * held in a component would not survive either. Session-scoped rather than
 * `localStorage` so it disappears with the tab instead of lingering on a
 * shared phone.
 *
 * It is NOT a credential. The code is re-checked server-side at POST /users
 * against a verified token; a tampered value here only produces a 403 there.
 */
const KEY = 'padel:inviteCode';

export function rememberInviteCode(code) {
  try {
    sessionStorage.setItem(KEY, code);
  } catch {
    // Private mode or storage disabled. The player can still enter the code
    // on the profile screen, which shows the field when none is remembered.
  }
}

export function recallInviteCode() {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function forgetInviteCode() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to clean up.
  }
}
