import { formatScore } from '../homeView.js';

/**
 * Step 4 — review the whole match and submit.
 *
 * Shows the raw facts only: court, both teams by name, the score. No rating, no
 * format, no prediction — the client sends facts and lets the backend decide.
 * The note sets the right expectation: nothing counts until the other team
 * confirms.
 */
export default function StepReview({ court, teamMineNames, teamOppNames, sets, submitError }) {
  return (
    <div className="step">
      <h2 className="step-heading">Check and submit</h2>

      <dl className="review">
        <div className="review-row">
          <dt>Court</dt>
          <dd>{court?.name}{court?.area ? ` · ${court.area}` : ''}</dd>
        </div>
        <div className="review-row">
          <dt>Your team</dt>
          <dd>{teamMineNames.join(' & ')}</dd>
        </div>
        <div className="review-row">
          <dt>Opponents</dt>
          <dd>{teamOppNames.join(' & ')}</dd>
        </div>
        <div className="review-row">
          <dt>Score</dt>
          <dd>{formatScore(sets)}</dd>
        </div>
      </dl>

      <p className="confirm-note">
        This match will count once the other team confirms it. Until then it stays
        pending and changes no one's rating.
      </p>

      {submitError && (
        <div className="field-error" role="alert">
          {submitError.split('\n').map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
