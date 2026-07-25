import { describe, it, expect } from 'vitest';

import { describeSubmitError } from './logErrors.js';
import { ApiError } from '../../api/ApiError.js';

const err = (status, body) => new ApiError(status, body, '/matches');

describe('describeSubmitError — points at the offending step', () => {
  it('routes a score rejection to the score step, in the server’s words', () => {
    const d = describeSubmitError(
      err(400, { error: 'Bad Request', errors: ['Set 2: 8-6 is not a legal set score.'] }),
    );
    expect(d.kind).toBe('validation');
    expect(d.step).toBe(3);
    expect(d.message).toMatch(/8-6 is not a legal set score/);
  });

  it('routes a player rejection to the players step', () => {
    const d = describeSubmitError(
      err(400, { error: 'Bad Request', errors: ['All four players must be distinct.'] }),
    );
    expect(d.step).toBe(2);
  });

  it('routes a court rejection to the court step', () => {
    const d = describeSubmitError(err(400, { errors: ['No court with id court-x.'] }));
    expect(d.step).toBe(1);
  });

  it('surfaces the reason when there is no error list', () => {
    const d = describeSubmitError(err(400, { error: 'Bad Request', reason: 'idempotencyKey must be a UUID.' }));
    expect(d.kind).toBe('validation');
    expect(d.message).toMatch(/idempotencyKey/);
  });
});

describe('describeSubmitError — non-validation outcomes', () => {
  it('treats a 409 replay as success, not an error', () => {
    expect(describeSubmitError(err(409, { reason: 'x' })).kind).toBe('replay');
  });

  it('words a network failure as reachability, and keeps the match', () => {
    const d = describeSubmitError(err(0, { reason: 'x' }));
    expect(d.kind).toBe('network');
    expect(d.message).toMatch(/still here/i);
    expect(d.step).toBeNull();
  });

  it('sends an expired session to sign in again', () => {
    expect(describeSubmitError(err(401, { reason: 'expired token' })).message).toMatch(/sign in again/i);
  });

  it('is generic for anything unexpected', () => {
    expect(describeSubmitError(err(500, null)).kind).toBe('other');
  });
});
