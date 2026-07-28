import { useState } from 'react';

import PlayerSearch from './PlayerSearch.jsx';

/**
 * Step 2 — pick the four players, two per team.
 *
 * The signed-in player is fixed on their team and cannot be removed — you can
 * only log a match you played in. They pick a partner and two opponents. All
 * four must be distinct; the search excludes anyone already chosen.
 */
export default function StepPlayers({ me, partner, opponents, onChange }) {
  // Which slot is being filled: 'partner' | 'opp0' | 'opp1' | null.
  const [filling, setFilling] = useState(null);

  const chosenIds = [me.id, partner?.id, opponents[0]?.id, opponents[1]?.id].filter(Boolean);

  function pick(player) {
    if (filling === 'partner') onChange({ partner: player, opponents });
    else if (filling === 'opp0') onChange({ partner, opponents: [player, opponents[1]] });
    else if (filling === 'opp1') onChange({ partner, opponents: [opponents[0], player] });
    setFilling(null);
  }

  function clear(slot) {
    if (slot === 'partner') onChange({ partner: null, opponents });
    else if (slot === 'opp0') onChange({ partner, opponents: [null, opponents[1]] });
    else if (slot === 'opp1') onChange({ partner, opponents: [opponents[0], null] });
  }

  if (filling) {
    const label =
      filling === 'partner' ? 'Add your partner' : 'Add an opponent';
    return (
      <div className="step">
        <PlayerSearch
          label={label}
          excludeIds={chosenIds}
          onPick={pick}
          onCancel={() => setFilling(null)}
        />
      </div>
    );
  }

  return (
    <div className="step">
      <h2 className="step-heading">Who played?</h2>

      <section className="team-block team-block-mine">
        <h3 className="roster-label">Your team</h3>
        <FixedSlot player={me} you />
        <Slot player={partner} label="Add partner" onAdd={() => setFilling('partner')} onClear={() => clear('partner')} />
      </section>

      <div className="vs-divider">VS</div>

      <section className="team-block">
        <h3 className="roster-label">Opponents</h3>
        <Slot player={opponents[0]} label="Add opponent" onAdd={() => setFilling('opp0')} onClear={() => clear('opp0')} />
        <Slot player={opponents[1]} label="Add opponent" onAdd={() => setFilling('opp1')} onClear={() => clear('opp1')} />
      </section>
    </div>
  );
}

function FixedSlot({ player, you }) {
  return (
    <div className="player-row player-row-fixed">
      <span className="avatar" aria-hidden="true">{player.name?.[0]?.toUpperCase() ?? '?'}</span>
      <span className="player-info">
        <span className="player-name">{player.name}{you && ' (you)'}</span>
        <span className="player-area">{player.area ?? '—'}</span>
      </span>
    </div>
  );
}

function Slot({ player, label, onAdd, onClear }) {
  if (!player) {
    return (
      <button type="button" className="add-slot" onClick={onAdd}>
        <span className="add-icon" aria-hidden="true">+</span>
        <span className="add-text">{label}</span>
      </button>
    );
  }
  return (
    <div className="player-row">
      <span className="avatar" aria-hidden="true">{player.name?.[0]?.toUpperCase() ?? '?'}</span>
      <span className="player-info">
        <span className="player-name">{player.name}</span>
        <span className="player-area">{player.area ?? '—'}</span>
      </span>
      <button type="button" className="slot-remove" aria-label={`Remove ${player.name}`} onClick={onClear}>
        ✕
      </button>
    </div>
  );
}
