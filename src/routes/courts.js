import { Router } from 'express';

import { requireAdmin } from '../middleware/auth.js';
import * as courts from '../services/courtsService.js';

export const courtsRouter = Router();

courtsRouter.get('/courts', async (req, res, next) => {
  try {
    const found = await courts.listCourts({
      area: req.query.area,
      search: req.query.search ?? req.query.q,
    });

    return res.json({ courts: found.map(courts.toCourtView) });
  } catch (err) {
    return next(err);
  }
});

/**
 * Admin only. The courts collection gates match submission — a player who can
 * add a court can invent a venue and validate their own fabricated match.
 */
courtsRouter.post('/courts', requireAdmin, async (req, res, next) => {
  try {
    const { rejected, errors } = courts.validateCourt(req.body);

    if (rejected.length > 0) {
      return res.status(400).json({
        error: 'Bad Request',
        reason: `Unknown fields: ${rejected.join(', ')}.`,
        rejected,
      });
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Bad Request', errors });
    }

    const created = await courts.createCourt(req.body);
    return res.status(201).json(courts.toCourtView(created));
  } catch (err) {
    return next(err);
  }
});
