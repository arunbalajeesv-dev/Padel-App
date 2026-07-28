import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/authContext.js';
import { getLeaderboard, ApiError } from '../api/index.js';
import { placementMessage } from './homeView.js';
import { POOLS, PERIODS, movementIndicator } from './leaderboardView.js';
import { CHENNAI_AREAS } from './chennaiAreas.js';

/** After this long with no response, assume Render's free tier is cold-starting. */
const COLD_START_MS = 4000;

/**
 * Leaderboard. Renders exactly the ranking getLeaderboard returns — the client
 * sorts nothing and computes no rating. Sorting (by stored rating, never the
 * clamped display value) and placement gating are the server's job.
 *
 * Three pools; optional area and period filters. Placement players do not appear
 * — that gating is the point. If the signed-in player is still in placement,
 * their row is pinned at the bottom showing the "keep playing" state, never a
 * fake rank.
 */
export default function Leaderboard() {
  const navigate = useNavigate();
  const { profile } = useAuth();

  const [pool, setPool] = useState('open');
  const [period, setPeriod] = useState('all');
  const [area, setArea] = useState('');

  const [board, setBoard] = useState({ status: 'loading', data: null, error: null });
  const [coldStart, setColdStart] = useState(false);

  useEffect(() => {
    let alive = true;
    setBoard({ status: 'loading', data: null, error: null });
    setColdStart(false);
    const timer = setTimeout(() => alive && setColdStart(true), COLD_START_MS);

    (async () => {
      try {
        const data = await getLeaderboard({ pool, area: area || undefined, period });
        if (alive) setBoard({ status: 'ready', data, error: null });
      } catch (err) {
        if (alive) setBoard({ status: 'error', data: null, error: err });
      } finally {
        clearTimeout(timer);
        if (alive) setColdStart(false);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pool, area, period]);

  const entries = board.data?.entries ?? [];
  const placement = placementMessage(profile?.placement);
  const inPlacement = profile?.status === 'placement';

  return (
    <section className="leaderboard">
      <h1 className="lb-title">Leaderboard</h1>

      {/* Pool selector */}
      <div className="segmented-control" role="tablist" aria-label="Leaderboard pool">
        {POOLS.map((p) => (
          <button
            key={p.value}
            type="button"
            role="tab"
            aria-selected={pool === p.value}
            className={pool === p.value ? 'segment segment-active' : 'segment'}
            onClick={() => setPool(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="filter-row">
        <select
          className="filter-chip"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          aria-label="Time period"
        >
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
        <select
          className="filter-chip"
          value={area}
          onChange={(e) => setArea(e.target.value)}
          aria-label="Area"
        >
          <option value="">All areas</option>
          {CHENNAI_AREAS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <div className="lb-content">
        {board.status === 'loading' && (coldStart ? <WakingUp /> : <RowSkeleton />)}

        {board.status === 'error' && <LoadError error={board.error} />}

        {board.status === 'ready' && entries.length === 0 && <EmptyState onLog={() => navigate('/log')} />}

        {board.status === 'ready' && entries.length > 0 && (
          <div className="lb-rows">
            {entries.map((row) => (
              <Row
                key={row.id}
                row={row}
                isMe={row.id === profile?.id}
                // Tapping yourself goes to the editable own-profile tab, not
                // the read-only PlayerProfile screen built for everyone else.
                onSelect={() => navigate(row.id === profile?.id ? '/profile' : `/players/${row.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* The signed-in player, pinned, when they're not yet on the board. */}
      {inPlacement && placement.show && (
        <button
          type="button"
          className="sticky-user-card"
          onClick={() => navigate('/profile')}
        >
          <span className="placement-label">Placement</span>
          <span className="avatar" aria-hidden="true">{profile?.name?.[0]?.toUpperCase() ?? '?'}</span>
          <span className="player-info">
            <span className="lb-name">{profile?.name} (You)</span>
            <span className="lb-area">{profile?.area ?? '—'}</span>
          </span>
          <span className="placement-text">{placement.text}</span>
        </button>
      )}
    </section>
  );
}

function Row({ row, isMe, onSelect }) {
  const move = movementIndicator(row.movement);
  return (
    <button
      type="button"
      className={isMe ? 'player-row player-row-me' : 'player-row'}
      onClick={onSelect}
    >
      <div className="rank-col">
        <span className="rank-number">{row.rank}</span>
        <span className={`rank-arrow ${move.className}`} title={move.label} aria-label={move.label}>
          {move.char}
        </span>
      </div>
      <span className="avatar" aria-hidden="true">{row.name?.[0]?.toUpperCase() ?? '?'}</span>
      <span className="player-info">
        <span className="lb-name">{row.name}{isMe ? ' (You)' : ''}</span>
        <span className="lb-area">{row.area ?? '—'}</span>
      </span>
      <span className="player-rating">{row.ratingDisplay?.toFixed(1) ?? '—'}</span>
    </button>
  );
}

/**
 * Empty pool. Tab-agnostic and points at the MATCH THRESHOLD, never at the
 * absence of people — an empty board that reads as "nobody like you plays here"
 * is discouraging and potentially self-fulfilling. See the wireframe's note.
 */
function EmptyState({ onLog }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true" />
      <h3>No rankings yet</h3>
      <p>Rankings appear once players have completed their first few matches.</p>
      <button className="btn-primary empty-log" type="button" onClick={onLog}>
        Log a match
      </button>
    </div>
  );
}

function WakingUp() {
  return (
    <div className="waking">
      <div className="spinner" aria-hidden="true" />
      <p>Waking up the server… the first load after a quiet spell takes a few seconds.</p>
    </div>
  );
}

function LoadError({ error }) {
  const offline = error instanceof ApiError && error.status === 0;
  return (
    <div className="load-error" role="alert">
      <p>
        {offline
          ? "Can't reach the server. Check your connection and try again."
          : "Couldn't load the leaderboard. Please try again."}
      </p>
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="lb-rows" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="player-row skeleton-lb-row" />
      ))}
    </div>
  );
}
