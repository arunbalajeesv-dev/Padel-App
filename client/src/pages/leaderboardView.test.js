import { describe, it, expect } from 'vitest';

import { movementIndicator, POOLS, PERIODS } from './leaderboardView.js';

describe('movementIndicator', () => {
  it('maps up/down/flat to distinct arrows and classes', () => {
    expect(movementIndicator('up')).toMatchObject({ char: '↑', className: 'move-up' });
    expect(movementIndicator('down')).toMatchObject({ char: '↓', className: 'move-down' });
    expect(movementIndicator('flat')).toMatchObject({ char: '–', className: 'move-flat' });
  });

  it('falls back to flat for anything unexpected — never invents a direction', () => {
    expect(movementIndicator(undefined).className).toBe('move-flat');
    expect(movementIndicator('sideways').char).toBe('–');
  });

  it('carries an accessible label', () => {
    expect(movementIndicator('up').label).toMatch(/up/);
    expect(movementIndicator('flat').label).toMatch(/no change/);
  });
});

describe('pool and period options match the API contract', () => {
  it('offers exactly men, women, open', () => {
    expect(POOLS.map((p) => p.value)).toEqual(['men', 'women', 'open']);
  });

  it('offers the three backend periods', () => {
    expect(PERIODS.map((p) => p.value).sort()).toEqual(['30d', '7d', 'all']);
  });
});
