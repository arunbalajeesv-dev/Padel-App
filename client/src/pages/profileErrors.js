/**
 * Turn an ApiError from POST /users into something a form can show.
 *
 * Pure, so the mapping is testable without rendering anything.
 *
 * The backend returns validation failures as a flat list of sentences, each
 * beginning with the field it concerns ("name must be a string of at least 2
 * characters."). Attaching each message to its input is the difference between
 * a user fixing the problem and a user guessing at it.
 */

/** Fields this form can actually show an error against. */
const FIELDS = ['name', 'gender', 'area', 'photoUrl'];

const NETWORK_MESSAGE =
  "Can't reach the server. Check your connection and try again.";

/**
 * @param {import('../api/ApiError.js').ApiError} error
 * @returns {{fieldErrors: Record<string,string>, formError: string|null}}
 */
export function fieldErrorsFrom(error) {
  const fieldErrors = {};
  let formError = null;

  // status 0 is our marker for "never reached the server" — a connectivity
  // problem, not a rejection, and it must not read as one.
  if (error?.status === 0) {
    return { fieldErrors, formError: NETWORK_MESSAGE };
  }

  if (error?.status === 400) {
    for (const message of error.errors ?? []) {
      const field = FIELDS.find((f) => message.toLowerCase().startsWith(f.toLowerCase()));
      if (field) {
        // Keep the first message per field; the backend does not send two for
        // the same field, and stacking them would be noise if it ever did.
        fieldErrors[field] ??= message;
      } else {
        formError = message;
      }
    }

    // Fields the client is not allowed to send at all. This is a bug in THIS
    // code, not something the player did — say so rather than blaming them.
    if (error.rejected?.length) {
      formError = `This app sent a field it may not set: ${error.rejected.join(', ')}.`;
    }

    if (!formError && Object.keys(fieldErrors).length === 0) {
      formError = error.reason ?? 'Please check the form and try again.';
    }

    return { fieldErrors, formError };
  }

  if (error?.status === 401 || error?.status === 403) {
    return { fieldErrors, formError: 'Your sign-in has expired. Please sign in again.' };
  }

  return {
    fieldErrors,
    formError: 'Something went wrong creating your profile. Please try again.',
  };
}
