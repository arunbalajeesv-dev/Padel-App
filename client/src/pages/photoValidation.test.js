import { describe, it, expect } from 'vitest';

import { validatePhotoFile } from './photoValidation.js';

describe('validatePhotoFile', () => {
  it('accepts a well-formed jpeg', () => {
    expect(validatePhotoFile({ type: 'image/jpeg', size: 1024 })).toBeNull();
  });

  it.each(['image/png', 'image/webp'])('accepts %s too', (type) => {
    expect(validatePhotoFile({ type, size: 1024 })).toBeNull();
  });

  it('requires a file at all', () => {
    expect(validatePhotoFile(null)).toBe('A photo file is required.');
    expect(validatePhotoFile(undefined)).toBe('A photo file is required.');
  });

  it('rejects an unsupported type', () => {
    expect(validatePhotoFile({ type: 'image/gif', size: 1024 })).toBe(
      'Please choose a JPEG, PNG, or WebP image.',
    );
  });

  it('rejects a file over 5MB', () => {
    expect(validatePhotoFile({ type: 'image/jpeg', size: 6 * 1024 * 1024 })).toBe(
      'Photo must be 5MB or smaller.',
    );
  });

  it('accepts exactly 5MB', () => {
    expect(validatePhotoFile({ type: 'image/jpeg', size: 5 * 1024 * 1024 })).toBeNull();
  });
});
