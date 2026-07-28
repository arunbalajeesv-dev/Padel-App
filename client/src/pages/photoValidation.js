/**
 * Client-side photo validation — mirrors the server's rules (photoService.js)
 * purely for fast feedback. The server re-validates regardless; this is a
 * boundary where trusting the client would be wrong.
 */

export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/**
 * @param {{type?: string, size?: number}} file
 * @returns {string|null} An error message, or null if the file is acceptable.
 */
export function validatePhotoFile(file) {
  if (!file) return 'A photo file is required.';
  if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) {
    return 'Please choose a JPEG, PNG, or WebP image.';
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return 'Photo must be 5MB or smaller.';
  }
  return null;
}
