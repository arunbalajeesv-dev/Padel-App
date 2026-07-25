import { formatScore, formatDate, teamNames } from './homeView.js';

/**
 * A match card, in one of two visually distinct modes.
 *
 * `pending` is the load-bearing distinction: a match awaiting confirmation MUST
 * look unfinished, because an unconfirmed match never affects any rating and the
 * player who sees a "finished"-looking card will not act. The pending mode gets
 * a coloured edge, a "Pending" chip, and action buttons; the rated mode is calm
 * and inert with a "Rated" check. See client/CLAUDE.md rule 4.
 */
export default function MatchCard({ match, names, mode, onConfirm, onDispute }) {
  const pending = mode === 'pending';
  const teamA = teamNames(match.teamA, names.players);
  const teamB = teamNames(match.teamB, names.players);
  const courtName = names.courts?.[match.courtId] ?? '';

  return (
    <article className={pending ? 'match-card match-card-pending' : 'match-card match-card-rated'}>
      <header className="match-card-top">
        <span>{formatDate(match.playedAt)}</span>
        <span>{courtName}</span>
      </header>

      <div className="match-teams">
        <div className="team">
          {teamA.map((n, i) => (
            <span key={i} className="team-player">{n}</span>
          ))}
        </div>
        <div className="vs">VS</div>
        <div className="team team-right">
          {teamB.map((n, i) => (
            <span key={i} className="team-player">{n}</span>
          ))}
        </div>
      </div>

      <footer className="match-card-bottom">
        <span className="match-score">{formatScore(match.sets)}</span>
        {pending ? (
          <span className="chip chip-pending">Pending</span>
        ) : (
          <span className="chip chip-rated">✓ Rated</span>
        )}
      </footer>

      {pending && (
        <div className="match-actions">
          <button className="btn-primary" type="button" onClick={() => onConfirm(match.id)}>
            Confirm match
          </button>
          <button className="btn-link" type="button" onClick={() => onDispute(match.id)}>
            Dispute result
          </button>
        </div>
      )}
    </article>
  );
}
