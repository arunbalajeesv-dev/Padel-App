import { ApiError } from '../api/index.js';
import MatchCard from './MatchCard.jsx';

/**
 * A player's resolved match history (rated + cancelled) — shared between the
 * signed-in player's own Profile and another player's PlayerProfile, since
 * both fetch the same shape (getRecentMatches / getUserMatches) and render it
 * identically.
 *
 * @param {{status: 'loading'|'ready'|'error', matches?: object[],
 *   players?: object, courts?: object, error?: Error}} state
 */
export default function PastMatches({ state }) {
  if (state.status === 'loading') {
    return (
      <div className="match-stack" aria-hidden="true">
        <div className="match-card skeleton-card" />
        <div className="match-card skeleton-card" />
      </div>
    );
  }

  if (state.status === 'error') {
    const offline = state.error instanceof ApiError && state.error.status === 0;
    return (
      <div className="load-error" role="alert">
        {offline
          ? "Can't reach the server. Check your connection and try again."
          : 'Could not load match history. Please try again.'}
      </div>
    );
  }

  const matches = state.matches ?? [];
  if (matches.length === 0) {
    return <p className="empty-note">No rated matches yet.</p>;
  }

  const names = { players: state.players ?? {}, courts: state.courts ?? {} };

  return (
    <div className="match-stack">
      {matches.map((m) => (
        <MatchCard key={m.id} match={m} names={names} mode={m.status === 'rejected' ? 'rejected' : 'rated'} />
      ))}
    </div>
  );
}
