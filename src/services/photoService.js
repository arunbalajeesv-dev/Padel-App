/**
 * Profile photo upload.
 *
 * The client never talks to Firebase Storage directly — see client/CLAUDE.md:
 * "Firebase in this app is Auth-in-the-browser and nothing else." A photo is
 * uploaded here, through the API, using the Admin SDK, which is the only
 * writer Storage rules need to trust (see storage.rules: everything else is
 * denied).
 *
 * Stored PUBLIC, at a fixed path per user, so re-uploading overwrites rather
 * than accumulating orphaned files, and the client can render `photoUrl`
 * directly as an <img src> with no signed-URL refresh logic. A profile photo
 * in a ~100-person community app is not sensitive data.
 */
import { getStorage } from '../config/firebase.js';

const EXT_FOR_TYPE = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * @param {{mimetype?: string, size?: number}|undefined} file A multer file
 *   object (or undefined if none was sent).
 * @returns {string[]} Validation errors, empty if the file is acceptable.
 */
export function validatePhoto(file) {
  if (!file) return ['A photo file is required.'];

  const errors = [];
  if (!Object.hasOwn(EXT_FOR_TYPE, file.mimetype)) {
    errors.push('Photo must be a JPEG, PNG, or WebP image.');
  }
  if (file.size > MAX_BYTES) {
    errors.push('Photo must be 5MB or smaller.');
  }
  return errors;
}

/**
 * Upload a validated photo to `users/{uid}/profile.{ext}`, public, and return
 * its URL. Caller must run `validatePhoto` first — this trusts its input.
 *
 * @param {string} uid
 * @param {{buffer: Buffer, mimetype: string}} file
 * @returns {Promise<string>}
 */
export async function uploadProfilePhoto(uid, file) {
  const ext = EXT_FOR_TYPE[file.mimetype];
  const blob = getStorage().file(`users/${uid}/profile.${ext}`);

  await blob.save(file.buffer, {
    contentType: file.mimetype,
    public: true,
    metadata: { cacheControl: 'public, max-age=3600' },
  });

  return blob.publicUrl();
}
