/**
 * Map a failed match submission to a message AND the step to send the player
 * back to, so a rejection points at the thing that was wrong.
 *
 * The server is the source of truth on legality, so its own words are surfaced
 * rather than a generic "failed" — a `Set 2: 8-6 is not a legal set score`
 * belongs in front of the player, at the score step.
 */

const STEP = { COURT: 1, PLAYERS: 2, SCORE: 3, REVIEW: 4 };

/**
 * @param {import('../../api/ApiError.js').ApiError} error
 * @returns {{ kind: 'network'|'validation'|'replay'|'other', message: string, step: number|null }}
 */
export function describeSubmitError(error) {
  // Never reached the server. The match is still in hand — invite a retry, do
  // not word it as a rejection of anything the player did.
  if (error?.status === 0) {
    return {
      kind: 'network',
      message: "Couldn't reach the server. Your match is still here — tap submit to try again.",
      step: null,
    };
  }

  // A 409 means this exact submission already landed (idempotency replay). The
  // match exists; that is success, not a failure.
  if (error?.status === 409) {
    return { kind: 'replay', message: '', step: null };
  }

  if (error?.status === 400) {
    const messages = error.errors?.length
      ? error.errors
      : error.reason
        ? [error.reason]
        : ['The match was rejected.'];
    const joined = messages.join(' ');

    // Route to the step that owns the rejected thing. Score first: its messages
    // ("Set 1: …", "games …") are the most specific.
    let step = STEP.REVIEW;
    if (/\bset\b|score|games|tiebreak|level/i.test(joined)) step = STEP.SCORE;
    else if (/player|team|distinct|opponent|uid/i.test(joined)) step = STEP.PLAYERS;
    else if (/court/i.test(joined)) step = STEP.COURT;

    return { kind: 'validation', message: messages.join('\n'), step };
  }

  if (error?.status === 401 || error?.status === 403) {
    return { kind: 'other', message: 'Your sign-in has expired. Please sign in again.', step: null };
  }

  return {
    kind: 'other',
    message: 'Something went wrong submitting the match. Please try again.',
    step: null,
  };
}

export { STEP };
