/**
 * Firebase auth error codes → messages a player can act on.
 *
 * Pure and exported so the mapping is testable without the SDK.
 *
 * The distinctions here are the ones that change what the user should DO. "Wrong
 * code" means try again; "expired" means request a new one; "too many attempts"
 * means stop and wait. Collapsing them into "Something went wrong" leaves a
 * player retyping a code that can never work.
 */

const MESSAGES = {
  // --- Sending the code ---
  'auth/invalid-phone-number':
    "That doesn't look like a valid phone number. Include the country code, e.g. +91.",
  'auth/missing-phone-number': 'Enter your phone number.',
  'auth/quota-exceeded':
    'We cannot send codes right now. Please try again later.',
  'auth/captcha-check-failed':
    'The security check failed. Reload the page and try again.',
  'auth/invalid-app-credential':
    'The security check failed. Reload the page and try again.',

  // --- Verifying the code ---
  'auth/invalid-verification-code':
    "That code isn't right. Check the SMS and try again.",
  'auth/missing-verification-code': 'Enter the 6-digit code from the SMS.',
  'auth/code-expired':
    'That code has expired. Request a new one.',
  'auth/invalid-verification-id':
    'This sign-in attempt has expired. Start again.',

  // --- Rate limiting and account state ---
  'auth/too-many-requests':
    'Too many attempts. Wait a few minutes before trying again.',
  'auth/user-disabled':
    'This account has been disabled. Contact an admin.',
  'auth/network-request-failed':
    'Network problem. Check your connection and try again.',
  'auth/operation-not-allowed':
    'Phone sign-in is not enabled for this project.',
};

/** Codes where retrying the same input cannot possibly help. */
const NEEDS_RESTART = new Set([
  'auth/code-expired',
  'auth/invalid-verification-id',
  'auth/captcha-check-failed',
  'auth/invalid-app-credential',
]);

/**
 * @param {unknown} error Anything thrown by the Firebase SDK.
 * @returns {{code: string, message: string, needsRestart: boolean}}
 */
export function describeAuthError(error) {
  const code = error?.code ?? 'unknown';
  return {
    code,
    message:
      MESSAGES[code] ??
      // Never surface a raw Firebase code to a player; it means nothing to them.
      'Something went wrong signing you in. Please try again.',
    needsRestart: NEEDS_RESTART.has(code),
  };
}
