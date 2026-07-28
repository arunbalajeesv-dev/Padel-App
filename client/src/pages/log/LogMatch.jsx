import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../../auth/authContext.js';
import { createMatch, newIdempotencyKey } from '../../api/index.js';
import { checkSets } from './scoreCheck.js';
import { describeSubmitError } from './logErrors.js';
import StepCourt from './StepCourt.jsx';
import StepPlayers from './StepPlayers.jsx';
import StepScore from './StepScore.jsx';
import StepReview from './StepReview.jsx';
import BackButton from '../BackButton.jsx';

/**
 * The Log Match flow: court → players → score → review → submit.
 *
 * One match at a time, no repeat-match shortcut. All entered data lives here and
 * survives moving between steps and a failed submit — a network error must not
 * cost the player everything they typed.
 *
 * The client sends the raw facts of the match (court, four players, games,
 * playedAt) and computes nothing the server owns — no rating, no format, no
 * winner. See client/CLAUDE.md.
 */
const STEP_COUNT = 4;

export default function LogMatch() {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const me = { id: profile.id, name: profile.name, area: profile.area, photoUrl: profile.photoUrl };

  const [step, setStep] = useState(1);
  const [court, setCourt] = useState(null);
  const [partner, setPartner] = useState(null);
  const [opponents, setOpponents] = useState([null, null]);
  const [sets, setSets] = useState([{ teamA: 0, teamB: 0 }]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  // One idempotency key per submit ATTEMPT-SEQUENCE. Held across a network retry
  // (same action → same key → the server dedupes if the first landed), and
  // regenerated only once a submission fully fails validation or succeeds.
  const keyRef = useRef(null);

  const teamMine = [me, partner];
  const teamOpp = opponents;
  const teamMineNames = teamMine.map((p) => p?.name ?? '');
  const teamOppNames = teamOpp.map((p) => p?.name ?? '');

  const canAdvance = {
    1: Boolean(court),
    2: Boolean(partner && opponents[0] && opponents[1]),
    3: checkSets(sets).ready,
    4: true,
  }[step];

  function back() {
    setSubmitError(null);
    if (step === 1) navigate('/');
    else setStep((s) => s - 1);
  }

  function next() {
    setSubmitError(null);
    if (step < STEP_COUNT) setStep((s) => s + 1);
  }

  async function submit() {
    if (submitting) return; // the disabled button is the first guard; this is the second
    setSubmitting(true);
    setSubmitError(null);

    if (!keyRef.current) keyRef.current = newIdempotencyKey();

    try {
      await createMatch({
        courtId: court.id,
        teamA: [me.id, partner.id],
        teamB: [opponents[0].id, opponents[1].id],
        sets: sets.map((s) => ({ teamA: s.teamA, teamB: s.teamB })),
        playedAt: new Date().toISOString(),
        idempotencyKey: keyRef.current,
      });
      // 201 (created) and 200 (idempotency replay) both resolve — both are success.
      navigate('/', { replace: true });
    } catch (err) {
      const described = describeSubmitError(err);

      // A 409 replay means this submission already created the match. Success.
      if (described.kind === 'replay') {
        navigate('/', { replace: true });
        return;
      }

      if (described.kind === 'network') {
        // Keep the key so the retry is the SAME action — do not mint a new one.
        setSubmitError(described.message);
        setSubmitting(false);
        return;
      }

      // Validation or other: the submission is spent. Drop the key so a corrected
      // resubmit is a fresh action, and send the player to the offending step.
      keyRef.current = null;
      setSubmitError(described.message);
      setSubmitting(false);
      if (described.step && described.step !== step) setStep(described.step);
    }
  }

  return (
    <section className="log-flow">
      <header className="log-header">
        <BackButton onClick={back} disabled={submitting} />
        <h1 className="log-title">Log a match</h1>
      </header>

      <div className="step-dots" aria-hidden="true">
        {Array.from({ length: STEP_COUNT }).map((_, i) => (
          <span key={i} className={i + 1 === step ? 'step-dot step-dot-active' : 'step-dot'} />
        ))}
      </div>

      <div className="log-content">
        {step === 1 && <StepCourt selected={court} onSelect={setCourt} />}
        {step === 2 && (
          <StepPlayers
            me={me}
            partner={partner}
            opponents={opponents}
            onChange={({ partner: p, opponents: o }) => {
              setPartner(p);
              setOpponents(o);
            }}
          />
        )}
        {step === 3 && (
          <StepScore
            sets={sets}
            teamMineNames={teamMineNames}
            teamOppNames={teamOppNames}
            onChange={setSets}
          />
        )}
        {step === 4 && (
          <StepReview
            court={court}
            teamMineNames={teamMineNames}
            teamOppNames={teamOppNames}
            sets={sets}
            submitError={submitError}
          />
        )}
      </div>

      <footer className="log-footer">
        {step < STEP_COUNT ? (
          <button type="button" className="btn-primary" onClick={next} disabled={!canAdvance}>
            Continue
          </button>
        ) : (
          <button type="button" className="btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit match'}
          </button>
        )}
      </footer>
    </section>
  );
}
