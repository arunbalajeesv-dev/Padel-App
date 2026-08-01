import { useState } from 'react';

import PlayerSearch from './PlayerSearch.jsx';

/**
 * Step 2 — pick the four players, two per team, and which side each played.
 *
 * The signed-in player is fixed on their team and cannot be removed — you can
 * only log a match you played in. They pick a partner and two opponents. All
 * four must be distinct; the search excludes anyone already chosen.
 *
 * Side (left/right) is relative to a player's OWN team, like deuce/ad in
 * tennis doubles — so both teams having a left and a right player is the
 * normal case, not a clash. Teammates can never share a side, so choosing
 * one player's side sets their partner's to the other automatically.
 */
export default function StepPlayers({ me, partner, opponents, sides, onChange }) {
  // Which slot is being filled: 'partner' | 'opp0' | 'opp1' | null.
  const [filling, setFilling] = useState(null);

  const chosenIds = [me.id, partner?.id, opponents[0]?.id, opponents[1]?.id].filter(Boolean);

  function pick(player) {
    if (filling === 'partner') onChange({ partner: player, opponents, sides });
    else if (filling === 'opp0') onChange({ partner, opponents: [player, opponents[1]], sides });
    else if (filling === 'opp1') onChange({ partner, opponents: [opponents[0], player], sides });
    setFilling(null);
  }

  function clear(slot) {
    // Drop the removed player's side too — a stale entry for someone no
    // longer in the match would be submitted as a phantom fourth side.
    const without = (uid) => {
      if (!uid) return sides;
      const { [uid]: _removed, ...rest } = sides;
      return rest;
    };
    if (slot === 'partner') onChange({ partner: null, opponents, sides: without(partner?.id) });
    else if (slot === 'opp0') onChange({ partner, opponents: [null, opponents[1]], sides: without(opponents[0]?.id) });
    else if (slot === 'opp1') onChange({ partner, opponents: [opponents[0], null], sides: without(opponents[1]?.id) });
  }

  /** Set one player's side and force their teammate (if picked) to the other. */
  function setSide(uid, side, teammateId) {
    const next = { ...sides, [uid]: side };
    if (teammateId) next[teammateId] = side === 'left' ? 'right' : 'left';
    onChange({ partner, opponents, sides: next });
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
      <p className="form-hint">
        Pick each player&apos;s side of the court. Left and right are relative to
        their own team.
      </p>

      <section className="team-block team-block-mine">
        <h3 className="roster-label">Your team</h3>
        <FixedSlot
          player={me}
          you
          side={sides[me.id]}
          onSide={(s) => setSide(me.id, s, partner?.id)}
        />
        <Slot
          player={partner}
          label="Add partner"
          onAdd={() => setFilling('partner')}
          onClear={() => clear('partner')}
          side={partner ? sides[partner.id] : undefined}
          onSide={(s) => setSide(partner.id, s, me.id)}
        />
      </section>

      <div className="vs-divider">VS</div>

      <section className="team-block">
        <h3 className="roster-label">Opponents</h3>
        <Slot
          player={opponents[0]}
          label="Add opponent"
          onAdd={() => setFilling('opp0')}
          onClear={() => clear('opp0')}
          side={opponents[0] ? sides[opponents[0].id] : undefined}
          onSide={(s) => setSide(opponents[0].id, s, opponents[1]?.id)}
        />
        <Slot
          player={opponents[1]}
          label="Add opponent"
          onAdd={() => setFilling('opp1')}
          onClear={() => clear('opp1')}
          side={opponents[1] ? sides[opponents[1].id] : undefined}
          onSide={(s) => setSide(opponents[1].id, s, opponents[0]?.id)}
        />
      </section>
    </div>
  );
}

/** Left/right picker for one player. Inert until that slot has a player. */
function SidePicker({ side, onSide, name }) {
  return (
    <span className="side-picker" role="radiogroup" aria-label={`Side for ${name}`}>
      {['left', 'right'].map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={side === s}
          className={side === s ? 'side-option side-option-active' : 'side-option'}
          onClick={() => onSide(s)}
        >
          {s === 'left' ? 'L' : 'R'}
        </button>
      ))}
    </span>
  );
}

function PlayerAvatar({ player }) {
  return (
    <span className="avatar" aria-hidden="true">
      {player.photoUrl ? (
        <img className="avatar-img" src={player.photoUrl} alt="" />
      ) : (
        player.name?.[0]?.toUpperCase() ?? '?'
      )}
    </span>
  );
}

function FixedSlot({ player, you, side, onSide }) {
  return (
    <div className="player-row player-row-fixed">
      <PlayerAvatar player={player} />
      <span className="player-info">
        <span className="player-name">{player.name}{you && ' (you)'}</span>
        <span className="player-area">{player.area ?? '—'}</span>
      </span>
      <SidePicker side={side} onSide={onSide} name={player.name} />
    </div>
  );
}

function Slot({ player, label, onAdd, onClear, side, onSide }) {
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
      <PlayerAvatar player={player} />
      <span className="player-info">
        <span className="player-name">{player.name}</span>
        <span className="player-area">{player.area ?? '—'}</span>
      </span>
      <SidePicker side={side} onSide={onSide} name={player.name} />
      <button type="button" className="slot-remove" aria-label={`Remove ${player.name}`} onClick={onClear}>
        ✕
      </button>
    </div>
  );
}
