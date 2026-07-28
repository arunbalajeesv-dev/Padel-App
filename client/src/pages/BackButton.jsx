/**
 * The back control for a focused sub-screen (ConfirmMatch, DisputeMatch,
 * PlayerProfile — screens with their own header and no tab bar). A circular
 * tap target with a chevron icon, shared so every sub-screen's back button
 * looks and behaves identically rather than each hand-rolling a "←" glyph.
 */
export default function BackButton({ onClick, label = 'Back' }) {
  return (
    <button type="button" className="back-btn" aria-label={label} onClick={onClick}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M15 5l-7 7 7 7"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
