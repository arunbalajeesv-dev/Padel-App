import { formatScore, formatDate, teamNames } from './homeView.js';

/**
 * A match card, in one of five viewer-relative modes:
 *
 *   'action'    — pending AND this viewer still owes a confirmation. The loud
 *                 state: coloured edge, Confirm + Dispute. This is the whole
 *                 point of the screen; an unconfirmed match never affects any
 *                 rating, so the player who must act cannot miss it.
 *   'waiting'   — pending but this viewer has already confirmed (e.g. the
 *                 reporter, auto-confirmed at creation). Visible so they know
 *                 it is logged, but NO Confirm button — you never confirm
 *                 twice — and a plain "waiting on the other team" status.
 *   'disputed'  — blocked on an admin decision. Nothing for the PLAYER to do —
 *                 no confirm, no dispute-again — just visibly unresolved.
 *   'rejected'  — a dispute an admin cancelled. Shown in recent activity so
 *                 the outcome is visible, never a rating, and never styled
 *                 like a settled result.
 *   'rated'     — confirmed and settled. Calm and inert with a "Rated" check.
 *
 * The action/waiting split is driven by the server's `viewerNeedsToConfirm`, so
 * the client never re-derives who may act. See client/CLAUDE.md rule 4.
 */
export default function MatchCard({ match, names, mode, onConfirm, onDispute }) {
  const teamA = teamNames(match.teamA, names.players);
  const teamB = teamNames(match.teamB, names.players);
  const courtName = names.courts?.[match.courtId] ?? '';

  // Who is still holding this up, by name — for the waiting status line.
  const awaitingNames = teamNames(match.awaitingConfirmationFrom ?? [], names.players);

  const CARD_CLASS = {
    action: 'match-card match-card-action',
    waiting: 'match-card match-card-waiting',
    disputed: 'match-card match-card-disputed',
    rejected: 'match-card match-card-rejected',
    rated: 'match-card match-card-rated',
  };

  return (
    <article className={CARD_CLASS[mode] ?? 'match-card'}>
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
        {mode === 'rated' && <span className="chip chip-rated">✓ Rated</span>}
        {mode === 'rejected' && <span className="chip chip-rejected">Cancelled</span>}
        {mode === 'disputed' && <span className="chip chip-disputed">Under review</span>}
        {(mode === 'action' || mode === 'waiting') && <span className="chip chip-pending">Pending</span>}
      </footer>

      {mode === 'action' && (
        <div className="match-actions">
          <button className="btn-primary" type="button" onClick={() => onConfirm(match.id)}>
            Confirm match
          </button>
          <button className="btn-link" type="button" onClick={() => onDispute(match.id)}>
            Dispute result
          </button>
        </div>
      )}

      {mode === 'waiting' && (
        <p className="waiting-status">
          {awaitingNames.length > 0
            ? `Waiting for ${awaitingNames.join(' or ')} to confirm`
            : 'Waiting for the other team to confirm'}
        </p>
      )}

      {mode === 'disputed' && (
        <p className="waiting-status">Blocked until an admin reviews it.</p>
      )}
    </article>
  );
}
