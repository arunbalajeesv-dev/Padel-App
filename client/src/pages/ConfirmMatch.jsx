import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import { getMatch, confirmMatch, ApiError } from '../api/index.js';
import { formatScore, formatDate, teamNames } from './homeView.js';

/**
 * Confirm Match. Loads one match in full and lets a participant confirm it.
 *
 * The client renders what the API returns and calls confirmMatch — it never
 * computes a rating. When a confirm COMPLETES the match, the engine has already
 * moved the ratings server-side, so we route back to Home where the updated
 * rating and now-rated match appear.
 */
export default function ConfirmMatch() {
  const { id } = useParams();
  const navigate = useNavigate();

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
          {alreadyConfirmed ? (
            <p className="confirm-note">
              You've confirmed this match. It's waiting on the other team before it
              counts.
            </p>
          ) : (
            <>
              <button className="btn-primary" type="button" onClick={confirm} disabled={submitting}>
                {submitting ? 'Confirming…' : 'Yes, this is correct'}
              </button>
              <button
                className="btn-link"
                type="button"
                onClick={() => navigate(`/matches/${id}/dispute`)}
                disabled={submitting}
              >
                Something's wrong — dispute
              </button>
            </>
          )}
          <p className="caption">Ratings update once both teams confirm.</p>
        </div>
      </div>
    </div>
  );
}

function ConfirmHeader({ onBack, title = 'Match' }) {
  return (
    <header className="confirm-header">
      <button type="button" className="back-btn" aria-label="Back" onClick={onBack}>←</button>
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
