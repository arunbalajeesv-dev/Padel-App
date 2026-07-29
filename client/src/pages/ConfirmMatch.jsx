import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import { getMatch, confirmMatch, ApiError } from '../api/index.js';
import { useAuth } from '../auth/authContext.js';
import { formatScore, formatDate, teamNames } from './homeView.js';
import BackButton from './BackButton.jsx';

/**
 * Confirm Match. Loads one match in full and lets a participant confirm it.
 *
 * The client renders what the API returns and calls confirmMatch — it never
 * computes a rating. When a confirm COMPLETES the match, the engine has already
 * moved the ratings server-side, so we RE-FETCH the profile before landing on
 * Home — otherwise the rating card would show the pre-match cached value (the
 * "still 2.3 after losing" bug).
 */
export default function ConfirmMatch() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refreshProfile } = useAuth();

  const [load, setLoad] = useState({ status: 'loading', data: null, error: null });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await getMatch(id);
        if (alive) setLoad({ status: 'ready', data, error: null });
      } catch (err) {
        if (alive) setLoad({ status: 'error', data: null, error: err });
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  async function confirm() {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // The response says whether this confirmation completed the match. Either
      // way the right place to land is Home: a completed match shows as rated
      // with a moved rating; a partial one shows as pending-waiting.
      await confirmMatch(id);

      // A completing confirm has already moved this player's rating server-side.
      // Re-fetch the profile so the auth context (which Home's rating card reads)
      // holds the new value, not the pre-match cache. Swallow a refresh failure —
      // the confirm itself succeeded, so we still proceed to Home rather than
      // stranding the player on this screen; Home will reconcile on next load.
      await refreshProfile().catch(() => {});

      navigate('/', { replace: true });
    } catch (err) {
      setSubmitError(err);
      setSubmitting(false);
    }
  }

  if (load.status === 'loading') {
    return (
      <div className="confirm-page">
        <ConfirmHeader onBack={() => navigate('/')} />
        <div className="confirm-body">
          <div className="skeleton-card confirm-skeleton" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (load.status === 'error') {
    return (
      <div className="confirm-page">
        <ConfirmHeader onBack={() => navigate('/')} />
        <div className="confirm-body">
          <LoadFailure error={load.error} />
        </div>
      </div>
    );
  }

  const { match, players, courts } = load.data;
  const names = { players, courts };
  const teamA = teamNames(match.teamA, players);
  const teamB = teamNames(match.teamB, players);
  const confirmedSet = new Set(match.confirmedBy ?? []);
  const alreadyConfirmed = !match.viewerNeedsToConfirm;

  return (
    <div className="confirm-page">
      <ConfirmHeader onBack={() => navigate('/')} title="Confirm match" />

      <div className="confirm-body">
        <p className="info-line">
          {names.players[match.reportedBy] ?? 'A player'} logged this match on{' '}
          {formatDate(match.playedAt)}.
        </p>

        {/* Score, large and clear, with the winning side marked. */}
        <div className="confirm-card">
          <div className="confirm-card-top">
            <span>{formatDate(match.playedAt)}</span>
            <span>{names.courts[match.courtId] ?? ''}</span>
          </div>

          <div className="confirm-teams">
            <div className={match.winner === 'A' ? 'confirm-team confirm-team-won' : 'confirm-team'}>
              {teamA.map((n, i) => <span key={i} className="confirm-player">{n}</span>)}
              {match.winner === 'A' && <span className="won-badge">Won</span>}
            </div>
            <div className="confirm-vs">VS</div>
            <div className={match.winner === 'B' ? 'confirm-team confirm-team-right confirm-team-won' : 'confirm-team confirm-team-right'}>
              {teamB.map((n, i) => <span key={i} className="confirm-player">{n}</span>)}
              {match.winner === 'B' && <span className="won-badge">Won</span>}
            </div>
          </div>

          <div className="confirm-score">{formatScore(match.sets)}</div>
        </div>

        {/* Who has confirmed, who has not. */}
        <section className="status-section">
          <h2 className="section-title">Confirmation status</h2>
          {[...match.teamA, ...match.teamB].map((uid) => (
            <div key={uid} className="status-row">
              <span className="avatar" aria-hidden="true">
                {(names.players[uid] ?? '?')[0]?.toUpperCase()}
              </span>
              <span className="status-name">
                {names.players[uid] ?? uid}
                {alreadyConfirmed && confirmedSet.has(uid) && match.reportedBy === uid ? ' (you)' : ''}
              </span>
              <span className={confirmedSet.has(uid) ? 'status-mark status-confirmed' : 'status-mark status-pending'}>
                {confirmedSet.has(uid) ? '✓' : '○'}
              </span>
            </div>
          ))}
        </section>

        {submitError && <SubmitError error={submitError} />}

        <div className="confirm-actions">
          <MatchActions
            match={match}
            alreadyConfirmed={alreadyConfirmed}
            submitting={submitting}
            onConfirm={confirm}
            onDispute={() => navigate(`/matches/${id}/dispute`)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * What this screen offers depends on `match.status`, not just whether THIS
 * viewer personally confirmed — a match reaches `confirmed` once one player
 * per team has, which can happen while the other two players (who never
 * clicked anything themselves) still show `viewerNeedsToConfirm: true`. Without
 * checking status first, those two would see live Confirm/Dispute buttons for
 * a match that already finished and can no longer be disputed (the backend
 * would 409 the dispute attempt — see disputesService.js).
 */
function MatchActions({ match, alreadyConfirmed, submitting, onConfirm, onDispute }) {
  if (match.status === 'confirmed') {
    return <p className="confirm-note">This match has already been confirmed and rated.</p>;
  }

  if (match.status === 'disputed') {
    return (
      <p className="confirm-note">
        This match is under review by an admin. It's blocked until they decide —
        nothing to do here for now.
      </p>
    );
  }

  if (match.status === 'rejected') {
    return <p className="confirm-note">This match was cancelled by an admin. It will not count.</p>;
  }

  if (alreadyConfirmed) {
    return (
      <>
        <p className="confirm-note">
          You've confirmed this match. It's waiting on the other team before it
          counts.
        </p>
        <p className="caption">Ratings update once both teams confirm.</p>
      </>
    );
  }

  return (
    <>
      <button className="btn-primary" type="button" onClick={onConfirm} disabled={submitting}>
        {submitting ? 'Confirming…' : 'Yes, this is correct'}
      </button>
      <button className="btn-link" type="button" onClick={onDispute} disabled={submitting}>
        Something's wrong — dispute
      </button>
      <p className="caption">Ratings update once both teams confirm.</p>
    </>
  );
}

function ConfirmHeader({ onBack, title = 'Match' }) {
  return (
    <header className="confirm-header">
      <BackButton onClick={onBack} />
      <h1 className="confirm-title">{title}</h1>
    </header>
  );
}

function LoadFailure({ error }) {
  let message = "Couldn't load this match. Please try again.";
  if (error instanceof ApiError) {
    if (error.status === 0) message = "Couldn't reach the server. Check your connection and try again.";
    else if (error.status === 404) message = 'This match no longer exists.';
    else if (error.status === 403) message = "You weren't part of this match.";
  }
  return <div className="field-error" role="alert"><p>{message}</p></div>;
}

/** A confirm-time error, worded for the specific cause. */
function SubmitError({ error }) {
  let message = 'Something went wrong. Please try again.';
  if (error instanceof ApiError) {
    if (error.status === 0) message = "Couldn't reach the server. Your confirmation didn't go through — try again.";
    else if (error.status === 403) message = "You can only confirm a match you played in.";
    else if (error.status === 409) message = error.reason ?? 'This match has already been resolved.';
    else if (error.reason) message = error.reason;
  }
  return <div className="field-error" role="alert"><p>{message}</p></div>;
}
