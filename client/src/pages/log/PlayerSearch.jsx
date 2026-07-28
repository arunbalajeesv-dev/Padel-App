import { useEffect, useRef, useState } from 'react';

import { searchUsers } from '../../api/index.js';

/**
 * A debounced player search that fills one slot. Results come from searchUsers,
 * which returns name, area and display rating only.
 *
 * `excludeIds` are players already chosen — the same person cannot be picked
 * twice, so they are filtered out of the results rather than shown-and-rejected.
 */
export default function PlayerSearch({ label, excludeIds, onPick, onCancel }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const { results: found } = await searchUsers(q);
        // Ignore a response that a newer keystroke has superseded.
        if (mine !== seq.current) return;
        setResults(found.filter((p) => !excludeIds.includes(p.id)));
      } catch {
        if (mine === seq.current) setResults([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query, excludeIds]);

  return (
    <div className="player-search">
      <div className="player-search-top">
        <span className="roster-label">{label}</span>
        <button type="button" className="btn-link btn-link-inline" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <input
        className="search-input"
        type="text"
        autoFocus
        placeholder="Search by name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {loading && <p className="search-status">Searching…</p>}
      {!loading && query.trim().length >= 2 && results.length === 0 && (
        <p className="search-status">No players found.</p>
      )}

      <div className="player-results">
        {results.map((p) => (
          <button key={p.id} type="button" className="player-row" onClick={() => onPick(p)}>
            <span className="avatar" aria-hidden="true">
              {p.photoUrl ? (
                <img className="avatar-img" src={p.photoUrl} alt="" />
              ) : (
                p.name?.[0]?.toUpperCase() ?? '?'
              )}
            </span>
            <span className="player-info">
              <span className="player-name">{p.name}</span>
              <span className="player-area">{p.area ?? '—'}</span>
            </span>
            <span className="player-rating">{p.ratingDisplay?.toFixed(1) ?? '—'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
