import { checkSets, setsWonByTeam } from './scoreCheck.js';

/**
 * Step 3 — enter the score, set by set, GAMES ONLY.
 *
 * One set is a single-set match; two or three sets are best-of-three. No
 * tiebreak points are entered — the legal endings already cover 7-6. The client
 * checks plausibility for instant feedback, but the server derives and validates
 * the format and legality on submit; nothing here is authoritative.
 */
const MAX_GAMES = 7;
const MAX_SETS = 3;

export default function StepScore({ sets, teamMineNames, teamOppNames, onChange }) {
  const { perSet, formatLabel } = checkSets(sets);
  const won = setsWonByTeam(sets);

  function setGames(index, side, value) {
    const clamped = Math.max(0, Math.min(MAX_GAMES, value));
    const next = sets.map((s, i) => (i === index ? { ...s, [side]: clamped } : s));
    onChange(next);
  }

  const addSet = () => sets.length < MAX_SETS && onChange([...sets, { teamA: 0, teamB: 0 }]);
  const removeSet = () => sets.length > 1 && onChange(sets.slice(0, -1));

  return (
    <div className="step">
      <h2 className="step-heading">What was the score?</h2>

      {/* Running summary of who is on which team. */}
      <div className="matchup-header">
        <div className="matchup-team">
          {teamMineNames.map((n, i) => <span key={i} className="matchup-player">{n}</span>)}
        </div>
        <span className="matchup-vs">{won.mine}–{won.theirs}</span>
        <div className="matchup-team matchup-team-right">
          {teamOppNames.map((n, i) => <span key={i} className="matchup-player">{n}</span>)}
        </div>
      </div>

      <div className="set-list">
        {sets.map((set, i) => (
          <div key={i} className="set-block">
            <div className="set-row">
              <span className="set-label">Set {i + 1}</span>
              <div className="stepper-group">
                <Stepper
                  value={set.teamA}
                  onDec={() => setGames(i, 'teamA', set.teamA - 1)}
                  onInc={() => setGames(i, 'teamA', set.teamA + 1)}
                />
                <span className="set-dash">–</span>
                <Stepper
                  value={set.teamB}
                  onDec={() => setGames(i, 'teamB', set.teamB - 1)}
                  onInc={() => setGames(i, 'teamB', set.teamB + 1)}
                />
              </div>
            </div>
            {perSet[i] && <p className="set-hint">{perSet[i]}</p>}
          </div>
        ))}
      </div>

      <div className="set-controls">
        <button type="button" className="btn-link" onClick={removeSet} disabled={sets.length <= 1}>
          Remove set
        </button>
        <button type="button" className="btn-link" onClick={addSet} disabled={sets.length >= MAX_SETS}>
          Add set
        </button>
      </div>

      {formatLabel && <p className="format-note">{formatLabel} · the server confirms this on submit</p>}
    </div>
  );
}

function Stepper({ value, onInc, onDec }) {
  return (
    <div className="stepper">
      <button type="button" className="stepper-btn" onClick={onDec} aria-label="Decrease">−</button>
      <span className="stepper-value">{value}</span>
      <button type="button" className="stepper-btn" onClick={onInc} aria-label="Increase">+</button>
    </div>
  );
}
