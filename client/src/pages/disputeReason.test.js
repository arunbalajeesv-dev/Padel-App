import { describe, it, expect } from 'vitest';

import { composeReason, validateDispute, DISPUTE_REASONS, OTHER } from './disputeReason.js';

describe('composeReason', () => {
  it('is just the category when there is no detail', () => {
    expect(composeReason('Wrong score', '')).toBe('Wrong score');
    expect(composeReason('Wrong score', undefined)).toBe('Wrong score');
  });

  it('combines category and trimmed detail', () => {
    expect(composeReason('Wrong score', '  it was 4-6 not 6-4  ')).toBe(
      'Wrong score — it was 4-6 not 6-4',
    );
  });

  it('is empty with nothing selected', () => {
    expect(composeReason(null, 'detail')).toBe('');
  });
});

describe('validateDispute', () => {
  it('requires a category', () => {
    const r = validateDispute(null, 'some detail here');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/choose/i);
  });

  it.each(DISPUTE_REASONS.filter((r) => r !== OTHER))(
    '"%s" is submittable alone — detail is optional',
    (reason) => {
      expect(validateDispute(reason, '')).toEqual({ ok: true, message: null });
    },
  );

  it('"Other" is NOT submittable without detail', () => {
    const r = validateDispute(OTHER, '');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/tell us/i);
  });

  it('"Other" IS submittable once there is detail', () => {
    expect(validateDispute(OTHER, 'the court was double-booked')).toEqual({
      ok: true,
      message: null,
    });
  });

  it('"Other" with only whitespace still counts as empty', () => {
    expect(validateDispute(OTHER, '   ').ok).toBe(false);
  });

  it('every category clears the backend 10-char minimum on its own', () => {
    // Guards against a future category short enough to fail server-side even
    // though the client thought it was ready.
    for (const reason of DISPUTE_REASONS) {
      if (reason === OTHER) continue;
      expect(composeReason(reason, '').length).toBeGreaterThanOrEqual(10);
    }
  });
});
