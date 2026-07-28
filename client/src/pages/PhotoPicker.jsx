import { useRef, useState } from 'react';

import { uploadPhoto, ApiError } from '../api/index.js';
import { validatePhotoFile } from './photoValidation.js';

/**
 * The tappable avatar circle that picks and previews a profile photo.
 *
 * Two modes, chosen by which callback is passed:
 *
 *  - `onUploaded(photoUrl)` — IMMEDIATE mode, for Profile edit, where a
 *    profile already exists: uploads to the server as soon as a valid file
 *    is picked, shows an in-flight spinner, and reports the resulting URL.
 *  - `onFileSelected(file)` — DEFERRED mode, for Signup, where no profile
 *    exists yet, so `POST /users/me/photo` would 403 (nothing to attach the
 *    photo to — see ProfileSetup.jsx). This mode only validates and hands
 *    back the raw File; the caller previews it locally (as an object URL,
 *    passed back in as `photoUrl`) and uploads it itself once the profile
 *    has actually been created.
 *
 * @param {{photoUrl: string|null, name: string, size?: number,
 *   onUploaded?: (photoUrl: string) => void,
 *   onFileSelected?: (file: File) => void, disabled?: boolean}} props
 */
export default function PhotoPicker({ photoUrl, name, size = 80, onUploaded, onFileSelected, disabled }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  function pick() {
    if (disabled || uploading) return;
    setError(null);
    inputRef.current?.click();
  }

  async function handleChange(event) {
    const file = event.target.files?.[0];
    // Reset so picking the SAME file again still fires a change event.
    event.target.value = '';
    if (!file) return;

    const message = validatePhotoFile(file);
    if (message) {
      setError(message);
      return;
    }
    setError(null);

    if (onFileSelected) {
      onFileSelected(file);
      return;
    }

    setUploading(true);
    try {
      const updated = await uploadPhoto(file);
      onUploaded?.(updated.photoUrl);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 0
          ? "Couldn't reach the server. Check your connection and try again."
          : 'Could not upload that photo. Please try again.',
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="photo-picker-wrap">
      <button
        type="button"
        className="photo-picker"
        style={{ width: size, height: size }}
        onClick={pick}
        disabled={disabled || uploading}
        aria-label={photoUrl ? 'Change profile photo' : 'Add a profile photo'}
      >
        <span className="photo-picker-circle">
          {photoUrl ? (
            <img className="photo-picker-img" src={photoUrl} alt="" />
          ) : (
            <span style={{ fontSize: Math.round(size * 0.35) }}>
              {name?.[0]?.toUpperCase() ?? '?'}
            </span>
          )}
        </span>

        {uploading && (
          <span className="photo-picker-overlay" aria-hidden="true">
            <span className="spinner" />
          </span>
        )}

        <span className="photo-picker-badge" aria-hidden="true">+</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="photo-picker-input"
        onChange={handleChange}
        tabIndex={-1}
        aria-hidden="true"
      />

      {error && (
        <p className="photo-picker-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
