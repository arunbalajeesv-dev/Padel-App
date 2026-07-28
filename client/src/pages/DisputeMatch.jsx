import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

import { getMatch, disputeMatch, ApiError } from '../api/index.js';
import { formatScore, formatDate, teamNames } from './homeView.js';
import { DISPUTE_REASONS, OTHER, composeReason, validateDispute } from './disputeReason.js';

/**
 * Dispute Match. Reached from Confirm's "Something's wrong — dispute" link,
 * which only appears while the match is still pending on the viewer.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAPPENS ON SUBMIT — verified against the backend before building this:
 *
 * Disputing a PENDING match (the only state reachable from here) flips its
 * status to `disputed`. From that moment `listPendingForPlayer` and
 * `listRecentForPlayer` both filter it out — there is no endpoint that returns a
 * disputed match to a player. So after a successful dispute the match simply
 * DISAPPEARS from Home; there is no "under review" card to render, because the
 * API never sends one. Home shows a one-time flash message instead, then the
 * match is just gone from the lists — that IS the correct state.
 * ---------------------------------------------------------------------------
 *
 * No photo upload: Storage is deferred, so this is text-only, per the client
 * rule against building against unbuilt infrastructure.
 */
export default function DisputeMatch() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [load, setLoad] = useState({ status: 'loading', data: null, error: null });
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState('');
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

  const check = validateDispute(selected, detail);

  async function submit() {
    if (submitting || !check.ok) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await disputeMatch(id, { reason: composeReason(selected, detail) });
      // Nothing left to show on this match — see the header note. Home reads
      // this flag once to flash the "flagged for review" confirmation.
      navigate('/', { replace: true, state: { disputedMatch: true } });
    } catch (err) {
      setSubmitError(err);
      setSubmitting(false);
    }
  }

  if (load.status === 'loading') {
    return (
      <div className="confirm-page">
        <DisputeHeader onBack={() => navigate(-1)} />
        <div className="confirm-body">
          <div className="skeleton-card confirm-skeleton" aria-hidden="true" />
        </div>
      </div>
    );
  }

  if (load.status === 'error') {
    return (
      <div className="confirm-page">
        <DisputeHeader onBack={() => navigate('/')} />
        <div className="confirm-body">
          <LoadFailure error={load.error} />
        </div>
      </div>
    );
  }

  const { match, players, courts } = load.data;
  const teamA = teamNames(match.teamA, players);
  const teamB = teamNames(match.teamB, players);

  return (
    <div className="confirm-page">
      <DisputeHeader onBack={() => navigate(-1)} />

      <div className="confirm-body">
        {/* Compact match summary, so the disputer sees exactly what they're
            disputing without leaving the screen. */}
        <div className="match-card match-card-compact">
          <header className="match-card-top">
            <span>{formatDate(match.playedAt)}</span>
            <span>{courts[match.courtId] ?? ''}</span>
          </header>
          <div className="match-teams">
            <div className="team">
              {teamA.map((n, i) => <span key={i} className="team-player">{n}</span>)}
            </div>
            <div className="vs">VS</div>
            <div className="team team-right">
              {teamB.map((n, i) => <span key={i} className="team-player">{n}</span>)}
            </div>
          </div>
          <footer className="match-card-bottom">
            <span className="match-score">{formatScore(match.sets)}</span>
            <span className="chip chip-pending">Pending</span>
          </footer>
        </div>

        <div className="dispute-form">
          <h2 className="section-title">What's wrong?</h2>
          <div className="radio-list" role="radiogroup" aria-label="Reason for dispute">
            {DISPUTE_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                role="radio"
                aria-checked={selected === reason}
                className={selected === reason ? 'radio-item radio-item-active' : 'radio-item'}
                onClick={() => setSelected(reason)}
              >
                <span className="radio-circle" aria-hidden="true" />
                <span className="radio-label">{reason}</span>
              </button>
            ))}
          </div>

          <label className="form-label" htmlFor="detail">
            Tell us more{selected === OTHER ? '' : ' (optional)'}
          </label>
          <textarea
            id="detail"
            className="dispute-textarea"
            placeholder="Tell us more"
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={4}
          />
        </div>

        {submitError && <SubmitError error={submitError} />}

        <div className="confirm-actions">
          <button className="btn-primary" type="button" onClick={submit} disabled={submitting || !check.ok}>
            {submitting ? 'Submitting…' : 'Submit dispute'}
          </button>
          <p className="caption">This match won't affect anyone's rating until an admin reviews it.</p>
        </div>
      </div>
    </div>
  );
}

function DisputeHeader({ onBack }) {
  return (
    <header className="confirm-header">
      <button type="button" className="back-btn" aria-label="Back" onClick={onBack}>←</button>
      <h1 className="confirm-title">Dispute match</h1>
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

/** A submit-time error, worded for the specific cause. */
function SubmitError({ error }) {
  let message = 'Something went wrong. Please try again.';
  if (error instanceof ApiError) {
    if (error.status === 0) {
      message = "Couldn't reach the server. Your dispute didn't go through — try again, your answers are still here.";
    } else if (error.status === 403) {
      message = 'You can only dispute a match you played in.';
    } else if (error.status === 409) {
      message = error.reason ?? 'This match has already been resolved or disputed.';
    } else if (error.reason) {
      message = error.reason;
    }
  }
  return <div className="field-error" role="alert"><p>{message}</p></div>;
}
