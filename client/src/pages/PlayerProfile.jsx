import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import { getUserProfile, getUserMatches, ApiError } from '../api/index.js';
import { tierLabel } from './homeView.js';
import { memberSince, gamesPlayedLabel, genderLabel } from './profileView.js';
import PastMatches from './PastMatches.jsx';
import BackButton from './BackButton.jsx';

/**
 * Another player's profile, reached by tapping a row on the Leaderboard.
 *
 * Read-only: no edit, no sign-out — those belong only on the signed-in
 * player's own Profile. Renders exactly what the API returns and computes
 * nothing about ratings — see client/CLAUDE.md.
 *
 * A focused sub-screen like ConfirmMatch/DisputeMatch: its own back button,
 * no tab bar, so it reuses their `.confirm-page` shell rather than a new one.
 */
export default function PlayerProfile() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [profileLoad, setProfileLoad] = useState({ status: 'loading', data: null, error: null });
  const [matchesLoad, setMatchesLoad] = useState({
    status: 'loading',
    matches: null,
    players: null,
    courts: null,
    error: null,
  });

  useEffect(() => {
    let alive = true;
    setProfileLoad({ status: 'loading', data: null, error: null });
    setMatchesLoad({ status: 'loading', matches: null, players: null, courts: null, error: null });

    (async () => {
      try {
        const data = await getUserProfile(id);
        if (alive) setProfileLoad({ status: 'ready', data, error: null });
      } catch (err) {
        if (alive) setProfileLoad({ status: 'error', data: null, error: err });
      }
    })();

    (async () => {
      try {
        const recent = await getUserMatches(id, { limit: 20 });
        if (alive) setMatchesLoad({ status: 'ready', ...recent, error: null });
      } catch (err) {
        if (alive) {
          setMatchesLoad({ status: 'error', matches: null, players: null, courts: null, error: err });
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="confirm-page">
      <header className="confirm-header">
        <BackButton onClick={() => navigate(-1)} />
        <h1 className="confirm-title">Player</h1>
      </header>

      <div className="confirm-body">
        {profileLoad.status === 'loading' && (
          <div className="skeleton-card confirm-skeleton" aria-hidden="true" />
        )}

        {profileLoad.status === 'error' && <ProfileLoadFailure error={profileLoad.error} />}

        {profileLoad.status === 'ready' && (
          <ProfileContent profile={profileLoad.data} matchesLoad={matchesLoad} />
        )}
      </div>
    </div>
  );
}

function ProfileContent({ profile, matchesLoad }) {
  return (
    <section className="profile-page">
      <header className="profile-header">
        <div className="avatar avatar-large" aria-hidden="true">
          {profile.name?.[0]?.toUpperCase() ?? '?'}
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
        <h2 className="section-title">Details</h2>
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
      </section>

      <section className="profile-section">
        <h2 className="section-title">Past matches</h2>
        <PastMatches state={matchesLoad} />
      </section>
    </section>
  );
}

function ProfileLoadFailure({ error }) {
  let message = "Couldn't load this profile. Please try again.";
  if (error instanceof ApiError) {
    if (error.status === 0) message = "Couldn't reach the server. Check your connection and try again.";
    else if (error.status === 404) message = 'This player no longer exists.';
  }
  return (
    <div className="field-error" role="alert">
      <p>{message}</p>
    </div>
  );
}
