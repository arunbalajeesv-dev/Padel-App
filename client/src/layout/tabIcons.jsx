/**
 * Bottom tab bar icons. Simple monochrome line icons, filled when the tab is
 * active — replaces the earlier grey placeholder boxes now that a real icon
 * set has been chosen. Each renders via `currentColor`, so `.tab`/`.tab-active`
 * (in index.css) still own the actual colour; these only supply the shape.
 */

const COMMON = { viewBox: '0 0 24 24', width: 24, height: 24, 'aria-hidden': true };

export function HomeIcon({ active }) {
  return active ? (
    <svg {...COMMON} fill="currentColor">
      <path d="M12 3 2.25 11h2.25v8a1 1 0 0 0 1 1H9.5v-6h5v6H19a1 1 0 0 0 1-1v-8h2.25L12 3z" />
    </svg>
  ) : (
    <svg {...COMMON} fill="none">
      <path
        d="M3.5 11.5 12 4.2l8.5 7.3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 10.2V19a1 1 0 0 0 1 1H9.5v-5.5h5V20H17.5a1 1 0 0 0 1-1v-8.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A padel paddle — a solid holed head on a short handle, not a strung racket. */
export function RacketIcon({ active }) {
  return active ? (
    <svg {...COMMON} fill="none">
      <rect x="6" y="2.5" width="12" height="14.5" rx="6" fill="currentColor" />
      <line x1="12" y1="17" x2="12" y2="21.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {[9.3, 12, 14.7].flatMap((cx) =>
        [7.3, 10, 12.7].map((cy) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="0.85" fill="#fff" />
        )),
      )}
    </svg>
  ) : (
    <svg {...COMMON} fill="none">
      <rect x="6" y="2.5" width="12" height="14.5" rx="6" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="17" x2="12" y2="21.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {[9.3, 12, 14.7].flatMap((cx) =>
        [7.3, 10, 12.7].map((cy) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="0.7" fill="currentColor" />
        )),
      )}
    </svg>
  );
}

export function TrophyIcon({ active }) {
  return active ? (
    <svg {...COMMON} fill="currentColor">
      <path d="M7 4h10v3.2a5 5 0 0 1-4 4.9v2.4h2a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1h2v-2.4a5 5 0 0 1-4-4.9V4z" />
      <path d="M7 5H4.6a2.6 2.6 0 0 0 2.4 2.6V5z" />
      <path d="M17 5h2.4A2.6 2.6 0 0 1 17 7.6V5z" />
    </svg>
  ) : (
    <svg {...COMMON} fill="none">
      <path
        d="M8 4h8v3.2a4 4 0 0 1-8 0V4z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M8 5H5.2A3 3 0 0 0 8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M16 5h2.8A3 3 0 0 1 16 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="11.6" x2="12" y2="16" stroke="currentColor" strokeWidth="2" />
      <line x1="9" y1="20" x2="15" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="16" x2="12" y2="20" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function UserIcon({ active }) {
  return active ? (
    <svg {...COMMON} fill="currentColor">
      <circle cx="12" cy="8" r="3.7" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0 1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" />
    </svg>
  ) : (
    <svg {...COMMON} fill="none">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5 19.5a7 7 0 0 1 14 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
