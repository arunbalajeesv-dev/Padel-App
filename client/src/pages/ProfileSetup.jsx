import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { createUser, uploadPhoto, ApiError } from '../api/index.js';
import { useAuth } from '../auth/authContext.js';
import { fieldErrorsFrom } from './profileErrors.js';
import { CHENNAI_AREAS } from './chennaiAreas.js';
import PhotoPicker from './PhotoPicker.jsx';

/**
 * Profile setup — the screen a phone-verified player sees before they have a
 * player record. Creates it via POST /users.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO SELF-RATING FIELD, AND THERE NEVER WILL BE.
 *
 * No skill level, no "what's your level?", no starting-rating picker, not even
 * as a hint. Every player starts at the same rating with a high RD, and the
 * rating is earned from match results alone. A self-assessment would let a
 * player seed their own position on the ladder — which is the one thing the
 * whole rating system exists to prevent.
 *
 * If a future change adds a level field here, that change is wrong.
 * ---------------------------------------------------------------------------
 *
 * This screen sends data and renders the result. It computes nothing about
 * ratings — see client/CLAUDE.md.
 */

export default function ProfileSetup() {
  const navigate = useNavigate();
  const { refreshProfile, signOut } = useAuth();

  const [name, setName] = useState('');
  const [gender, setGender] = useState(null);
  const [area, setArea] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Picked here, uploaded only after the profile exists — see PhotoPicker's
  // "DEFERRED mode" note. POST /users/me/photo requires a profile document,
  // which does not exist until createUser below succeeds.
  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);

  function handlePhotoSelected(file) {
    setPhotoFile(file);
    setPhotoPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }

  // Object URLs are not garbage-collected on their own — release the last one
  // if the player navigates away mid-setup.
  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  /** Land on Home with the auth context knowing we now have a profile. */
  async function enterApp() {
    await refreshProfile();
    navigate('/', { replace: true });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return; // Belt and braces with the disabled button.

    setFieldErrors({});
    setFormError(null);

    // Client-side check for the one thing the form can know on its own. The
    // server validates too — this only saves a round trip.
    if (!gender) {
      setFieldErrors({ gender: 'Choose one so we know which leaderboard you belong on.' });
      return;
    }

    setSubmitting(true);
    try {
      await createUser({
        name: name.trim(),
        gender,
        // Omitted when blank rather than sent as '' — an empty string is a
        // valid string to the API and would be stored as a real, empty area.
        ...(area.trim() ? { area: area.trim() } : {}),
        // photoUrl is deliberately absent: it is set by uploading below, once
        // a profile document actually exists for it to attach to.
      });

      if (photoFile) {
        // Non-fatal: the account already exists at this point. A failed
        // upload should not strand the player on this screen — they can add
        // a photo later from Profile.
        await uploadPhoto(photoFile).catch(() => {});
      }

      await enterApp();
    } catch (err) {
      // A profile already exists for this account. That is not a failure — the
      // player is simply already set up, so send them in rather than showing an
      // error they can do nothing about.
      if (err instanceof ApiError && err.status === 409) {
        await enterApp();
        return;
      }

      const mapped = fieldErrorsFrom(err);
      setFieldErrors(mapped.fieldErrors);
      setFormError(mapped.formError);
      setSubmitting(false);
    }
  }

  return (
    <section className="page setup-page">
      <h1 className="setup-title">Create your profile</h1>
      <p className="setup-subtitle">
        Your phone is verified. This is the last step.
      </p>

      <form className="setup-form" onSubmit={handleSubmit} noValidate>
        <div className="photo-block">
          <PhotoPicker
            photoUrl={photoPreview}
            name={name}
            onFileSelected={handlePhotoSelected}
            disabled={submitting}
          />
          <p className="photo-caption">
            {photoPreview ? 'Added once you finish' : 'Optional — can be added later'}
          </p>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="name">Name</label>
          <input
            id="name"
            className="input-field"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="How you're known on court"
            maxLength={60}
            required
            aria-invalid={Boolean(fieldErrors.name)}
          />
          {fieldErrors.name && <p className="field-message">{fieldErrors.name}</p>}
        </div>

        <div className="form-group">
          <span className="form-label" id="gender-label">Gender</span>
          <div className="segmented-control" role="radiogroup" aria-labelledby="gender-label">
            {[
              ['M', 'Male'],
              ['F', 'Female'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={gender === value}
                className={gender === value ? 'segment segment-active' : 'segment'}
                onClick={() => setGender(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="form-hint">
            Sets whether you appear on the men's or women's leaderboard. Everyone
            appears on the Open board too. An admin can change this later.
          </p>
          {fieldErrors.gender && <p className="field-message">{fieldErrors.gender}</p>}
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="area">
            Home area <span className="form-optional">optional</span>
          </label>
          <input
            id="area"
            className="input-field"
            list="chennai-areas"
            value={area}
            onChange={(e) => setArea(e.target.value)}
            placeholder="e.g. Adyar"
            aria-invalid={Boolean(fieldErrors.area)}
          />
          <datalist id="chennai-areas">
            {CHENNAI_AREAS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          <p className="form-hint">Lets you filter the leaderboard to players near you.</p>
          {fieldErrors.area && <p className="field-message">{fieldErrors.area}</p>}
        </div>

        {/* Not a field — an explanation for the field players expect and will
            not find. Most rating apps ask you to rate yourself; this one never
            will, and saying so up front is better than leaving them hunting. */}
        <p className="setup-note">
          There's no skill level to enter. Your rating starts the same as
          everyone's and is earned from match results.
        </p>

        {formError && (
          <p className="field-error" role="alert">
            {formError}
          </p>
        )}

        <button className="btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create profile'}
        </button>
      </form>

      <button className="btn-link" type="button" onClick={signOut} disabled={submitting}>
        Sign out
      </button>
    </section>
  );
}
