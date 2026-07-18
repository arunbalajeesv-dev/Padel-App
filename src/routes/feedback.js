import { Router } from 'express';

import * as feedback from '../services/feedbackService.js';

export const feedbackRouter = Router();

/**
 * Submit sportsmanship feedback for the other three players in a match.
 *
 * Sportsmanship only. This endpoint cannot move a skill rating — see the header
 * of feedbackService.js.
 */
feedbackRouter.post('/feedback', async (req, res, next) => {
  try {
    const { rejected, errors } = feedback.validateCreate(req.body);

    if (rejected.length > 0) {
      return res.status(400).json({
        error: 'Bad Request',
        reason: `These fields cannot be set by the client: ${rejected.join(', ')}.`,
        rejected,
      });
    }
    if (errors.length > 0) return res.status(400).json({ error: 'Bad Request', errors });

    const result = await feedback.submitFeedback({ uid: req.uid, body: req.body });

    return res.status(201).json(result.feedback);
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: err.error, reason: err.reason });
    }
    return next(err);
  }
});
