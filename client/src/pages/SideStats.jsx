/**
 * Left/right court-side record. Renders exactly what the API returns —
 * `dominantSide` is the server's call (it decides whether there is enough
 * data on both sides to name one at all), never re-derived here. See
 * client/CLAUDE.md rule 1.
 */
export default function SideStats({ stats }) {
  if (!stats) return null;

  const { left, right, dominantSide } = stats;
  const played = left.matches + right.matches;

  if (played === 0) {
    return (
      <section className="profile-section">
        <h2 className="section-title">Court side</h2>
        <p className="page-note">
          Once you&apos;ve played matches on both sides, your stronger side shows up here.
        </p>
      </section>
    );
  }

  return (
    <section className="profile-section">
      <h2 className="section-title">Court side</h2>
      <div className="side-stats">
        <SideCard label="Left" data={left} dominant={dominantSide === 'left'} />
        <SideCard label="Right" data={right} dominant={dominantSide === 'right'} />
      </div>
      <p className="page-note" style={{ marginTop: 8 }}>
        {dominantSide
          ? `You win more often on the ${dominantSide}.`
          : 'Not enough matches on both sides yet to call a stronger side.'}
      </p>
    </section>
  );
}

function SideCard({ label, data, dominant }) {
  const rate = data.matches > 0 ? Math.round((data.wins / data.matches) * 100) : null;
  return (
    <div className={dominant ? 'side-stat side-stat-dominant' : 'side-stat'}>
      <div className="side-stat-label">{label}</div>
      <div className="side-stat-value">{rate === null ? '—' : `${rate}%`}</div>
      <div className="side-stat-sub">
        {data.matches === 0
          ? 'no matches'
          : `${data.wins}W · ${data.matches - data.wins}L`}
      </div>
    </div>
  );
}
