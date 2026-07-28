import { describe, it, expect } from 'vitest';

import { memberSince, gamesPlayedLabel, genderLabel } from './profileView.js';

describe('memberSince', () => {
  it('formats an ISO date as "Member since Mon YYYY"', () => {
    expect(memberSince('2026-07-15T10:00:00.000Z')).toBe('Member since Jul 2026');
  });

  it('degrades safely on a bad date rather than throwing', () => {
    expect(memberSince('not-a-date')).toBe('');
    expect(memberSince(undefined)).toBe('');
  });
});

describe('gamesPlayedLabel', () => {
  it('singularises exactly one match', () => {
    expect(gamesPlayedLabel(1)).toBe('Match played');
  });

  it('pluralises zero and many', () => {
    expect(gamesPlayedLabel(0)).toBe('Matches played');
    expect(gamesPlayedLabel(12)).toBe('Matches played');
  });

  it('falls back safely on a non-number', () => {
    expect(gamesPlayedLabel(undefined)).toBe('Matches played');
    expect(gamesPlayedLabel(NaN)).toBe('Matches played');
  });
});

describe('genderLabel', () => {
  it('maps the stored code to a word', () => {
    expect(genderLabel('M')).toBe('Male');
    expect(genderLabel('F')).toBe('Female');
  });

  it('falls back on anything else rather than showing a raw code', () => {
    expect(genderLabel(undefined)).toBe('—');
    expect(genderLabel('X')).toBe('—');
  });
});
