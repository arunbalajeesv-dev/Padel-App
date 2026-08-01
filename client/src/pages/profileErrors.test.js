import { describe, it, expect } from 'vitest';

import { fieldErrorsFrom } from './profileErrors.js';
import { ApiError } from '../api/ApiError.js';

const apiError = (status, body) => new ApiError(status, body, '/users');

describe('fieldErrorsFrom — validation messages attach to their field', () => {
  it('routes each backend message to the input it concerns', () => {
    const { fieldErrors, formError } = fieldErrorsFrom(
      apiError(400, {
        error: 'Bad Request',
        errors: [
          'name must be a string of at least 2 characters.',
          'gender must be one of: M, F.',
        ],
      }),
    );

    expect(fieldErrors.name).toMatch(/at least 2 characters/);
    expect(fieldErrors.gender).toMatch(/one of: M, F/);
    expect(formError).toBeNull();
  });

  it('handles the area message too', () => {
    const { fieldErrors } = fieldErrorsFrom(
      apiError(400, { errors: ['area must be a string or null.'] }),
    );
    expect(fieldErrors.area).toBeDefined();
  });

  it('falls back to a form-level message when it cannot place one', () => {
    const { fieldErrors, formError } = fieldErrorsFrom(
      apiError(400, { errors: ['Something unplaceable happened.'] }),
    );

    expect(fieldErrors).toEqual({});
    expect(formError).toBe('Something unplaceable happened.');
  });

  it('blames the app, not the player, for a rejected field', () => {
    // A rejected field means THIS code sent something it may not — a client bug.
    const { formError } = fieldErrorsFrom(
      apiError(400, { error: 'Bad Request', reason: 'x', rejected: ['rating'] }),
    );

    expect(formError).toMatch(/app sent a field it may not set: rating/);
  });

  it('keeps one message per field', () => {
    const { fieldErrors } = fieldErrorsFrom(
      apiError(400, {
        errors: ['name must be a string of at least 2 characters.', 'name is also bad.'],
      }),
    );
    expect(fieldErrors.name).toMatch(/at least 2 characters/);
  });
});

describe('fieldErrorsFrom — non-validation failures', () => {
  it('says the server is unreachable for a network failure, not "invalid"', () => {
    // Status 0 is the client's marker for "never reached the server". Wording it
    // as a rejection would send the player hunting for a mistake they did not make.
    const { formError, fieldErrors } = fieldErrorsFrom(apiError(0, { reason: 'x' }));

    expect(formError).toMatch(/Can't reach the server/);
    expect(fieldErrors).toEqual({});
  });

  it('tells an expired session to sign in again', () => {
    expect(fieldErrorsFrom(apiError(401, { reason: 'expired token' })).formError).toMatch(
      /sign in again/i,
    );
    expect(fieldErrorsFrom(apiError(403, { reason: 'nope' })).formError).toMatch(
      /sign in again/i,
    );
  });

  it('attaches the soft-launch invite-gate 403 to the inviteCode field, not "sign in again"', () => {
    const { fieldErrors, formError } = fieldErrorsFrom(
      apiError(403, { error: 'Forbidden', reason: 'a valid invite code is required to sign up right now' }),
    );

    expect(fieldErrors.inviteCode).toMatch(/isn't valid/i);
    expect(formError).toBeNull();
  });

  it('gives a generic message for anything unexpected', () => {
    expect(fieldErrorsFrom(apiError(500, null)).formError).toMatch(/went wrong/i);
  });

  it('does not invent field errors for a 400 with no detail', () => {
    const { fieldErrors, formError } = fieldErrorsFrom(apiError(400, { error: 'Bad Request' }));

    expect(fieldErrors).toEqual({});
    expect(formError).toBeTruthy();
  });
});
