/**
 * Admin surface. Every route here is behind requireAdmin.
 *
 * Mounted BELOW the blanket requireAuth (so req.user exists), and the router
 * applies requireAdmin to all of its routes — there is no non-admin path in.
 */
import { Router } from 'express';

import { requireAdmin } from '../middleware/auth.js';
import { getConfig } from '../services/configService.js';
import * as disputes from '../services/disputesService.js';
import * as invites from '../services/inviteCodesService.js';
import * as courts from '../services/courtsService.js';
import { setAnchor, findById as findUser } from '../services/usersService.js';
import { weeklyGainAlerts } from '../services/alertsService.js';
import { adminStats } from '../services/statsService.js';
import { trustLeaderboard, trustFor } from '../services/trustService.js';

export const adminRouter = Router();

// Gate the whole surface. Belt and braces with the per-route need for req.user.
adminRouter.use(requireAdmin);

const badRequest = (res, errors) => res.status(400).json({ error: 'Bad Request', errors });

const reject = (res, rejected, reason) =>
  res.status(400).json({ error: 'Bad Request', reason, rejected });

/** Services throw errors with a `status`; anything else is a real 500. */
function handleServiceError(err, res, next) {
  if (err?.status) {
    return res.status(err.status).json({ error: err.error, reason: err.reason });
  }
  return next(err);
}

// --- Disputes --------------------------------------------------------------

adminRouter.get('/disputes', async (req, res, next) => {
  try {
    return res.json({ disputes: await disputes.listQueue() });
  } catch (err) {
    return next(err);
  }
});

adminRouter.post('/disputes/:id/resolve', async (req, res, next) => {
  try {
    const { rejected, errors } = disputes.validateResolve(req.body);
    if (rejected.length > 0) return reject(res, rejected, `Unknown fields: ${rejected.join(', ')}.`);
    if (errors.length > 0) return badRequest(res, errors);

    const result = await disputes.resolveDispute({
      disputeId: req.params.id,
      uid: req.uid,
      body: req.body,
    });
    return res.json(result);
  } catch (err) {
    return handleServiceError(err, res, next);
  }
});

// --- Anchors ---------------------------------------------------------------

adminRouter.post('/anchors', async (req, res, next) => {
  try {
    const { userId, isAnchor } = req.body ?? {};
    const errors = [];
    if (typeof userId !== 'string' || userId.trim().length === 0) errors.push('userId is required.');
    if (typeof isAnchor !== 'boolean') errors.push('isAnchor must be a boolean.');
    if (errors.length > 0) return badRequest(res, errors);

    const updated = await setAnchor(userId, isAnchor);
    if (!updated) return res.status(404).json({ error: 'Not Found', reason: 'no such user' });

    return res.json({ id: updated.id, name: updated.name, isAnchor: updated.isAnchor === true });
  } catch (err) {
    return next(err);
  }
});

// --- Courts ----------------------------------------------------------------

/**
 * Admin court creation. The public router also exposes POST /courts (admin-only);
 * both delegate to the same service. This path exists so court management sits
 * under the one admin surface.
 */
adminRouter.post('/courts', async (req, res, next) => {
  try {
    const { rejected, errors } = courts.validateCourt(req.body);
    if (rejected.length > 0) return reject(res, rejected, `Unknown fields: ${rejected.join(', ')}.`);
    if (errors.length > 0) return badRequest(res, errors);

    const created = await courts.createCourt(req.body);
    return res.status(201).json(courts.toCourtView(created));
  } catch (err) {
    return next(err);
  }
});

// --- Invite codes (CRUD) ---------------------------------------------------

adminRouter.get('/invite-codes', async (req, res, next) => {
  try {
    return res.json({ inviteCodes: await invites.listCodes() });
  } catch (err) {
    return next(err);
  }
});

adminRouter.post('/invite-codes', async (req, res, next) => {
  try {
    const { rejected, errors } = invites.validateCreate(req.body);
    if (rejected.length > 0) return reject(res, rejected, `Unknown fields: ${rejected.join(', ')}.`);
    if (errors.length > 0) return badRequest(res, errors);

    const created = await invites.createCode(req.body);
    return res.status(201).json(created);
  } catch (err) {
    if (err?.code === 6 || err?.code === 'already-exists') {
      return res.status(409).json({ error: 'Conflict', reason: 'that code already exists' });
    }
    return next(err);
  }
});

adminRouter.patch('/invite-codes/:id', async (req, res, next) => {
  try {
    const { rejected, errors } = invites.validateUpdate(req.body);
    if (rejected.length > 0) return reject(res, rejected, `Unknown fields: ${rejected.join(', ')}.`);
    if (errors.length > 0) return badRequest(res, errors);

    const updated = await invites.updateCode(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not Found', reason: 'no such invite code' });

    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

adminRouter.delete('/invite-codes/:id', async (req, res, next) => {
  try {
    const deleted = await invites.deleteCode(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not Found', reason: 'no such invite code' });

    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

// --- Stats & alerts --------------------------------------------------------

adminRouter.get('/stats', async (req, res, next) => {
  try {
    return res.json(await adminStats());
  } catch (err) {
    return next(err);
  }
});

/**
 * Weekly-gain alert. Surfaces players whose 7-day rating gain crosses the
 * configured threshold, WITH the context (distinct opponents, match count) a
 * human needs to tell a streak from a ring. It presents; it never adjudicates.
 */
adminRouter.get('/alerts/weekly-gain', async (req, res, next) => {
  try {
    const config = await getConfig();
    return res.json(await weeklyGainAlerts(config));
  } catch (err) {
    return next(err);
  }
});

// --- Trust scores (internal, admin-only) -----------------------------------

adminRouter.get('/trust', async (req, res, next) => {
  try {
    const config = await getConfig();
    return res.json({ trust: await trustLeaderboard(config) });
  } catch (err) {
    return next(err);
  }
});

adminRouter.get('/trust/:id', async (req, res, next) => {
  try {
    const target = await findUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'Not Found', reason: 'no such user' });

    const config = await getConfig();
    return res.json(await trustFor(req.params.id, config));
  } catch (err) {
    return next(err);
  }
});
