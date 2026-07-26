import { Router } from 'express';

import { findById as findCourt } from '../services/courtsService.js';
import { findById as findUser } from '../services/usersService.js';
import { confirmMatch } from '../services/confirmationService.js';
import * as disputes from '../services/disputesService.js';
import * as matches from '../services/matchesService.js';

export const matchesRouter = Router();

const badRequest = (res, errors) => res.status(400).json({ error: 'Bad Request', errors });

/**
 * Every pending match the caller is part of — Home's highest-priority section.
 * Each match is tagged `viewerNeedsToConfirm` so Home can show the action-needed
 * state (a Confirm button) or the waiting state (no button) per viewer.
 *
 * Registered BEFORE `/matches/:id` and POST `/matches/:id/*` — a literal path
 * always wins over the parameter, so `pending` is never read as an id.
 */
matchesRouter.get('/matches/pending', async (req, res, next) => {
  try {
    return res.json(await matches.listPendingForPlayer(req.uid));
  } catch (err) {
    return next(err);
  }
});

/** The caller's recent rated matches, newest first. */
matchesRouter.get('/matches/recent', async (req, res, next) => {
  try {
    const raw = Number(req.query.limit);
    const limit = Number.isInteger(raw) && raw > 0 && raw <= 50 ? raw : 10;
    return res.json(await matches.listRecentForPlayer(req.uid, { limit }));
  } catch (err) {
    return next(err);
  }
});

/**
 * A single match in full, for the Confirm screen. Participants only — 403 for a
 * non-participant, 404 for an unknown id. Registered AFTER the literal GET routes
 * above so `/matches/pending` and `/matches/recent` are not captured as ids.
 */
matchesRouter.get('/matches/:id', async (req, res, next) => {
  try {
    return res.json(await matches.getMatchForPlayer(req.uid, req.params.id));
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ error: err.error, reason: err.reason });
    }
    return next(err);
  }
});

matchesRouter.post('/matches', async (req, res, next) => {
  try {
    const body = req.body ?? {};

    // Cheap checks first: shape, then the rules that need no database read.
    const { rejected, errors } = matches.validateCreate(body);

    if (rejected.length > 0) {
      // Naming the fields is deliberate, as at signup: a client sending `format`
      // has a bug, and a silent strip would let it ship believing the value took
      // effect. See CLAUDE.md > "Request bodies are allowlisted".
      return res.status(400).json({
        error: 'Bad Request',
        reason: `These fields cannot be set by the client: ${rejected.join(', ')}.`,
        rejected,
      });
    }
    if (errors.length > 0) return badRequest(res, errors);

    const distinctErrors = matches.validateDistinct(body);
    if (distinctErrors.length > 0) return badRequest(res, distinctErrors);

    const players = matches.playersOf(body);

    // You may only report a match you played in. This is an authorisation
    // failure, not a malformed request.
    if (!players.includes(req.uid)) {
      return res.status(403).json({
        error: 'Forbidden',
        reason: 'You can only report a match you played in.',
      });
    }

    // Score legality. The validator's messages are written for the UI, so they
    // are passed through verbatim.
    const validated = matches.validateScore(body.sets);
    if (!validated.valid) return badRequest(res, validated.errors);

    // Court must exist — this is an anti-abuse rule, not a lookup convenience.
    // Without it a player could invent a venue and validate a fabricated match.
    const court = await findCourt(body.courtId);
    if (!court) {
      return badRequest(res, [`No court with id ${body.courtId}.`]);
    }

    const found = await Promise.all(players.map((uid) => findUser(uid)));
    const missing = players.filter((_, i) => !found[i]);
    if (missing.length > 0) {
      return badRequest(res, [`Unknown player uid(s): ${missing.join(', ')}.`]);
    }

    // Double-tap guard. The key identifies the submit action, so a resend of the
    // same key returns the match it already created rather than a second one.
    // 200 rather than 201: nothing was created by this request.
    const { match, created } = await matches.createMatch({
      body,
      reporterUid: req.uid,
      validated,
    });

    return res.status(created ? 201 : 200).json(matches.toMatchView(match));
  } catch (err) {
    return next(err);
  }
});

/**
 * Confirm a match. Once one player from EACH team has confirmed, this is the
 * request that applies ratings — atomically, and exactly once.
 *
 * The response is the ordinary match view. It carries no delta, no multiplier
 * and no rating state: those are written to the match document for audit, and
 * never served to a browser.
 */
matchesRouter.post('/matches/:id/confirm', async (req, res, next) => {
  try {
    const { match, applied } = await confirmMatch({
      matchId: req.params.id,
      uid: req.uid,
    });

    return res.json({ ...matches.toMatchView(match), ratingApplied: applied });
  } catch (err) {
    // The service throws participation and state errors with a status attached;
    // anything without one is a bug and belongs to the error handler.
    if (err?.status) {
      return res.status(err.status).json({ error: err.error, reason: err.reason });
    }
    return next(err);
  }
});

/**
 * Dispute a match.
 *
 * A pending match becomes `disputed` and can never be rated. A match that was
 * already rated is FLAGGED, not reversed — the response says which happened via
 * `ratingsApplied`, because "we have blocked this" and "a human will look at
 * this" are very different promises to make to a player.
 */
matchesRouter.post('/matches/:id/dispute', async (req, res, next) => {
  try {
    const { rejected, errors } = disputes.validateCreate(req.body);

    if (rejected.length > 0) {
      return res.status(400).json({
        error: 'Bad Request',
        reason: `These fields cannot be set by the client: ${rejected.join(', ')}.`,
        rejected,
      });
    }
    if (errors.length > 0) return badRequest(res, errors);

    const { dispute, ratingsApplied } = await disputes.raiseDispute({
      matchId: req.params.id,
      uid: req.uid,
      body: req.body,
    });

    return res.status(201).json({ ...dispute, ratingsApplied });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({
        error: err.error,
        reason: err.reason,
        ...(err.existingDisputeId ? { existingDisputeId: err.existingDisputeId } : {}),
      });
    }
    return next(err);
  }
});
