import { useEffect, useState } from 'react';

import { useAuth } from '../auth/authContext.js';
import { patchMe, getRecentMatches, deletePhoto, ApiError } from '../api/index.js';
import { fieldErrorsFrom } from './profileErrors.js';
import { tierLabel } from './homeView.js';
import { memberSince, gamesPlayedLabel, genderLabel } from './profileView.js';
import { CHENNAI_AREAS } from './chennaiAreas.js';
import PastMatches from './PastMatches.jsx';
import PhotoPicker from './PhotoPicker.jsx';

/**
 * Profile: the signed-in player's own details, edit, match history and sign
 * out. Renders exactly what the API returns and computes nothing about
 * ratings — see client/CLAUDE.md.
 *
 * `profile` comes from the auth context, already loaded by getMe. Only past
 * matches are fetched here.
 */
export default function Profile() {
  const { profile, refreshProfile, signOut } = useAuth();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Shows the new photo (or its removal) instantly, rather than waiting on
  // refreshProfile's round trip — refreshProfile still runs either way, to
  // keep the auth context (and every other screen reading `profile`) in sync.
  //
  // `undefined` means "no override yet — show profile.photoUrl". That has to
  // be a distinct sentinel from `null`: null is a real override value (photo
  // was just removed), and `null ?? profile.photoUrl` would otherwise fall
  // through to the old photo instead of showing "removed".
  const [photoOverride, setPhotoOverride] = useState(undefined);
  const [removingPhoto, setRemovingPhoto] = useState(false);
  const [removePhotoError, setRemovePhotoError] = useState(null);

  const displayedPhotoUrl = photoOverride !== undefined ? photoOverride : profile?.photoUrl ?? null;

  async function handlePhotoUploaded(photoUrl) {
    setPhotoOverride(photoUrl);
    await refreshProfile();
  }

  async function handleRemovePhoto() {
    if (removingPhoto) return;
    setRemovingPhoto(true);
    setRemovePhotoError(null);
    try {
      await deletePhoto();
      setPhotoOverride(null);
      await refreshProfile();
    } catch (err) {
      setRemovePhotoError(
        err instanceof ApiError && err.status === 0
          ? "Couldn't reach the server. Check your connection and try again."
          : 'Could not remove your photo. Please try again.',
      );
    } finally {
      setRemovingPhoto(false);
    }
  }

  const [matches, setMatches] = useState({
    status: 'loading',
    matches: null,
    players: null,
    courts: null,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const recent = await getRecentMatches({ limit: 20 });
        if (alive) setMatches({ status: 'ready', ...recent, error: null });
      } catch (err) {
        if (alive) {
          setMatches({ status: 'error', matches: null, players: null, courts: null, error: err });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function startEditing() {
    setName(profile?.name ?? '');
    setArea(profile?.area ?? '');
    setFieldErrors({});
    setFormError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setFieldErrors({});
    setFormError(null);
  }

  async function handleSave(event) {
    event.preventDefault();
    if (saving) return;

    setFieldErrors({});
    setFormError(null);
    setSaving(true);
    try {
      await patchMe({
        name: name.trim(),
        // Sent as null rather than omitted: this is an edit, so an emptied
        // field is a real request to clear it, not a field left untouched.
        area: area.trim() ? area.trim() : null,
      });
      await refreshProfile();
      setEditing(false);
    } catch (err) {
      const mapped = fieldErrorsFrom(err);
      setFieldErrors(mapped.fieldErrors);
      setFormError(mapped.formError);
    } finally {
      setSaving(false);
    }
  }

  if (!profile) return null; // RequireAuth guarantees this only while READY

  return (
    <section className="page profile-page">
      <header className="profile-header">
        <div className="profile-photo-col">
          <PhotoPicker
            photoUrl={displayedPhotoUrl}
            name={profile.name}
            size={64}
            onUploaded={handlePhotoUploaded}
          />
          {displayedPhotoUrl && (
            <button
              type="button"
              className="btn-link btn-link-inline"
              onClick={handleRemovePhoto}
              disabled={removingPhoto}
            >
              {removingPhoto ? 'Removing…' : 'Remove'}
            </button>
          )}
          {removePhotoError && (
            <p className="photo-picker-error" role="alert">
              {removePhotoError}
            </p>
          )}
        </div>
        <div>
          <h1 className="profile-name">{profile.name}</h1>
          <p className="profile-meta">{memberSince(profile.createdAt)}</p>
        </div>
      </header>

      <div className="profile-stats">
        <div className="profile-stat">
          <span className="profile-stat-value">{profile.ratingDisplay.toFixed(1)}</span>
          <span className="profile-stat-label">{tierLabel(profile.status)}</span>
        </div>
        <div className="profile-stat">
          <span className="profile-stat-value">{profile.gamesPlayed}</span>
          <span className="profile-stat-label">{gamesPlayedLabel(profile.gamesPlayed)}</span>
        </div>
      </div>

      <section className="profile-section">
        <div className="profile-section-top">
          <h2 className="section-title">Details</h2>
          {!editing && (
            <button className="btn-link btn-link-inline" type="button" onClick={startEditing}>
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <form className="setup-form" onSubmit={handleSave} noValidate>
            <div className="form-group">
              <label className="form-label" htmlFor="profile-name">Name</label>
              <input
                id="profile-name"
                className="input-field"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                required
                aria-invalid={Boolean(fieldErrors.name)}
              />
              {fieldErrors.name && <p className="field-message">{fieldErrors.name}</p>}
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="profile-area">
                Home area <span className="form-optional">optional</span>
              </label>
              <input
                id="profile-area"
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
              {fieldErrors.area && <p className="field-message">{fieldErrors.area}</p>}
            </div>

            {formError && (
              <p className="field-error" role="alert">
                {formError}
              </p>
            )}

            <div className="profile-edit-actions">
              <button className="btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button
                className="btn-link"
                type="button"
                onClick={cancelEditing}
                disabled={saving}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <dl className="profile-detail-list">
            <div className="profile-detail-row">
              <dt>Gender</dt>
              <dd>{genderLabel(profile.gender)}</dd>
            </div>
            <div className="profile-detail-row">
              <dt>Area</dt>
              <dd>{profile.area ?? '—'}</dd>
            </div>
          </dl>
        )}

        {!editing && (
          <p className="form-hint">
            Gender can only be changed by an admin — ask an organiser if yours is wrong.
          </p>
        )}
      </section>

      <section className="profile-section">
        <h2 className="section-title">Past matches</h2>
        <PastMatches state={matches} />
      </section>

      <button className="btn-link profile-signout" type="button" onClick={signOut}>
        Sign out
      </button>
    </section>
  );
}
