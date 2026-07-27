/**
 * Pure presentation helpers for the leaderboard. No sorting, no rating math —
 * the server ranks and gates; the client only maps the values it returns to
 * icons and labels.
 */

export const POOLS = [
  { value: 'men', label: "Men's" },
  { value: 'women', label: "Women's" },
  { value: 'open', label: 'Open' },
];

export const PERIODS = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: 'This month' },
  { value: '7d', label: 'This week' },
];

/**
 * The movement arrow for a row. The backend returns 'up' | 'down' | 'flat'
 * (flat = no history in the window = a fact, not a guess). Anything unexpected
 * falls to flat rather than inventing a direction.
 */
export function movementIndicator(movement) {
  switch (movement) {
    case 'up':
      return { char: '↑', label: 'moved up', className: 'move-up' };
    case 'down':
      return { char: '↓', label: 'moved down', className: 'move-down' };
    default:
      return { char: '–', label: 'no change', className: 'move-flat' };
  }
}
