import { useEffect, useState } from 'react';

import { listCourts, ApiError } from '../../api/index.js';

/**
 * Step 1 — pick a court from the directory.
 *
 * There is NO free-text entry. A match must reference a real court in the
 * `courts` collection — that is an anti-abuse control (a player who could invent
 * a venue could validate a fabricated match). So the court can only be one the
 * API returns.
 */
export default function StepCourt({ selected, onSelect }) {
  const [all, setAll] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { courts } = await listCourts();
        if (alive) setAll(courts);
      } catch (err) {
        if (alive) setError(err);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const shown = (all ?? []).filter(
    (c) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      (c.area ?? '').toLowerCase().includes(q),
  );

  return (
    <div className="step">
      <h2 className="step-heading">Where did you play?</h2>

      <input
        className="search-input"
        type="text"
        placeholder="Search courts"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error && (
        <p className="field-error" role="alert">
          {error instanceof ApiError && error.status === 0
            ? "Couldn't reach the server to load courts."
            : "Couldn't load courts. Please try again."}
        </p>
      )}

      {all === null && !error && <ListSkeleton rows={4} />}

      {all !== null && shown.length === 0 && (
        <p className="empty-note">
          {q ? 'No courts match that search.' : 'No courts in the directory yet.'}
        </p>
      )}

      <div className="court-list">
        {shown.map((court) => (
          <button
            key={court.id}
            type="button"
            className={
              selected?.id === court.id ? 'court-row court-row-selected' : 'court-row'
            }
            onClick={() => onSelect(court)}
          >
            <span className="court-name">{court.name}</span>
            <span className="court-meta">
              <span className="court-area">{court.area}</span>
              {court.isPartner && <span className="tag">Partner</span>}
              {selected?.id === court.id && <span className="tag tag-selected">Selected</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ListSkeleton({ rows }) {
  return (
    <div className="court-list" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="court-row skeleton-row" />
      ))}
    </div>
  );
}
