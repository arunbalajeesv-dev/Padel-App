import { Router } from 'express';

import { getLeaderboard, POOLS, PERIODS } from '../services/leaderboardService.js';

export const leaderboardRouter = Router();

/**
 * GET /leaderboard?pool=men|women|open&area=OMR&period=7d|30d|all
 *
 * `pool` defaults to `open` — every player, unfiltered. There is no mixed pool;
 * see leaderboardService.js.
 *
 * `period` sets the window the movement indicator compares against. It does not
 * change who appears or how they are ranked: the board always answers "who is
 * best right now", and a player who stops playing does not fall off it.
 */
leaderboardRouter.get('/leaderboard', async (req, res, next) => {
  try {
    const pool = req.query.pool ?? 'open';
    const period = req.query.period ?? '30d';
    const area = req.query.area ?? null;

    const errors = [];
    if (!POOLS.includes(pool)) {
      errors.push(`pool must be one of: ${POOLS.join(', ')}.`);
    }
    if (!PERIODS.includes(period)) {
      errors.push(`period must be one of: ${PERIODS.join(', ')}.`);
    }
    if (area !== null && (typeof area !== 'string' || area.trim().length === 0)) {
      errors.push('area must be a non-empty string.');
    }

    if (errors.length > 0) return res.status(400).json({ error: 'Bad Request', errors });

    const entries = await getLeaderboard({ pool, area, period });

    return res.json({ pool, area, period, entries });
  } catch (err) {
    return next(err);
  }
});
