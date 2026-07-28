import { Router } from 'express';
import multer from 'multer';

import { requireVerifiedToken, requireAdmin } from '../middleware/auth.js';
import { getConfig } from '../services/configService.js';
import * as users from '../services/usersService.js';
import { listRecentForPlayer } from '../services/matchesService.js';
import { validatePhoto, uploadProfilePhoto } from '../services/photoService.js';

/** Buffered in memory, never written to disk — 5MB matches validatePhoto's cap. */
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('photo');

/**
 * Run multer as a promise instead of router middleware, so an oversized or
 * malformed upload becomes an ordinary 400 from THIS route's own try/catch
 * rather than an uncaught MulterError reaching the generic error handler.
 */
function parsePhotoUpload(req, res) {
  return new Promise((resolve, reject) => {
    photoUpload(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Signup only. Mounted ABOVE the blanket requireAuth, because the caller by
 * definition has no profile yet.
 *
 * KEEP THIS ROUTER TO ONE ROUTE. Anything added here bypasses the blanket auth
 * that protects everything else.
 */
export const signupRouter = Router();

signupRouter.post('/users', requireVerifiedToken, async (req, res, next) => {
  try {
    // requireVerifiedToken permits a null profile — that is the whole point of
    // this route. But if one already exists, this is a duplicate signup.
    if (req.user) {
      return res.status(409).json({
        error: 'Conflict',
        reason: 'a profile already exists for this account',
      });
    }

    const { rejected, errors } = users.validateCreate(req.body);

    if (rejected.length > 0) {
      // Naming the fields is deliberate: a client sending `rating` has a bug,
      // and a silent strip would let it ship believing the value took effect.
      return res.status(400).json({
        error: 'Bad Request',
        reason: `These fields cannot be set by the client: ${rejected.join(', ')}.`,
        rejected,
      });
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Bad Request', errors });
    }

    const config = await getConfig();
    const created = await users.createUser({
      uid: req.uid,
      phone: req.token?.phone_number ?? null,
      input: req.body,
      config,
    });

    return res.status(201).json(users.toSelfView(created, config));
  } catch (err) {
    // Lost the race against a concurrent signup for the same uid.
    if (err?.code === 6 || err?.code === 'already-exists') {
      return res.status(409).json({
        error: 'Conflict',
        reason: 'a profile already exists for this account',
      });
    }
    return next(err);
  }
});

/** Everything here is mounted BELOW the blanket requireAuth. */
export const usersRouter = Router();

usersRouter.get('/users/me', async (req, res, next) => {
  try {
    const config = await getConfig();
    return res.json(users.toSelfView(req.user, config));
  } catch (err) {
    return next(err);
  }
});

usersRouter.patch('/users/me', async (req, res, next) => {
  try {
    const { rejected, errors } = users.validatePatch(req.body);

    if (rejected.length > 0) {
      return res.status(400).json({
        error: 'Bad Request',
        reason: `Only name, photoUrl and area can be changed. Rejected: ${rejected.join(', ')}.`,
        rejected,
      });
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Bad Request', errors });
    }

    const config = await getConfig();
    const updated = await users.updateUser(req.uid, req.body);

    return res.json(users.toSelfView(updated, config));
  } catch (err) {
    return next(err);
  }
});

/**
 * Upload a profile photo. Multipart, one file field named `photo`.
 *
 * The client never touches Firebase Storage directly (see photoService.js) —
 * this is the one path a photo can reach it, through the Admin SDK. Reuses
 * `updateUser`'s existing `photoUrl` allowlist entry rather than writing the
 * field directly, so this stays subject to the same patch path as any other
 * profile edit.
 */
usersRouter.post('/users/me/photo', async (req, res, next) => {
  try {
    try {
      await parsePhotoUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        const reason =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Photo must be 5MB or smaller.'
            : `Upload failed: ${err.message}`;
        return res.status(400).json({ error: 'Bad Request', errors: [reason] });
      }
      throw err;
    }

    const errors = validatePhoto(req.file);
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Bad Request', errors });
    }

    const photoUrl = await uploadProfilePhoto(req.uid, req.file);
    const updated = await users.updateUser(req.uid, { photoUrl });

    const config = await getConfig();
    return res.json(users.toSelfView(updated, config));
  } catch (err) {
    return next(err);
  }
});

/**
 * Admin-only profile edit. Exists mainly so gender can be corrected.
 *
 * Registered AFTER /users/me so Express does not match `:id` = "me".
 *
 * Gender is mutable and this is safe: `pairingType` is frozen on every match
 * document, so changing it cannot rewrite matches already played. It moves the
 * player to the correct leaderboard, which is the point. Admin-gated for a log
 * and a human check, not because self-serve would invite abuse. See CLAUDE.md.
 */
usersRouter.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rejected, errors } = users.validatePatch(req.body, { asAdmin: true });

    if (rejected.length > 0) {
      return res.status(400).json({
        error: 'Bad Request',
        reason: `Admins may change: ${users.ADMIN_PATCHABLE_FIELDS.join(', ')}. Rejected: ${rejected.join(', ')}.`,
        rejected,
      });
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Bad Request', errors });
    }

    const target = await users.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'Not Found', reason: 'no such user' });
    }

    // The log half of "a log and a human check". A gender change moves someone
    // between leaderboards, so it should be traceable to the admin who made it.
    if (Object.hasOwn(req.body, 'gender') && req.body.gender !== target.gender) {
      console.log(
        `[admin] ${req.uid} changed gender of ${target.id} from ${target.gender} to ${req.body.gender}`,
      );
    }

    const config = await getConfig();
    const updated = await users.updateUser(req.params.id, req.body, { asAdmin: true });

    return res.json(users.toSelfView(updated, config));
  } catch (err) {
    return next(err);
  }
});

usersRouter.get('/users/search', async (req, res, next) => {
  try {
    const q = req.query.q ?? req.query.query;
    if (!q || String(q).trim().length === 0) {
      return res.status(400).json({ error: 'Bad Request', reason: 'q is required.' });
    }

    const config = await getConfig();
    const found = await users.searchUsers(q);

    // Public view: name, area, ratingDisplay. Never phone, never rating state.
    return res.json({ results: found.map((u) => users.toPublicView(u, config)) });
  } catch (err) {
    return next(err);
  }
});

/**
 * Another player's profile — reached from the leaderboard (or search, later).
 * Registered AFTER /users/me and /users/search so Express does not match
 * `:id` = "me" or "search". Any signed-in player may look up any other: this
 * is the same trust level as the leaderboard and search results, just a
 * richer view once a player has actually been picked out.
 */
usersRouter.get('/users/:id', async (req, res, next) => {
  try {
    const target = await users.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'Not Found', reason: 'no such user' });
    }

    const config = await getConfig();
    return res.json(users.toPlayerView(target, config));
  } catch (err) {
    return next(err);
  }
});

/**
 * Another player's recent RATED matches — the same shape /matches/recent
 * returns for the caller, scoped to `:id` instead of `req.uid`.
 * `listRecentForPlayer` is already viewer-agnostic (it takes a uid and needs
 * nothing else about who is asking), so this reuses it rather than
 * duplicating the query.
 */
usersRouter.get('/users/:id/matches', async (req, res, next) => {
  try {
    const target = await users.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ error: 'Not Found', reason: 'no such user' });
    }

    const raw = Number(req.query.limit);
    const limit = Number.isInteger(raw) && raw > 0 && raw <= 50 ? raw : 10;

    return res.json(await listRecentForPlayer(req.params.id, { limit }));
  } catch (err) {
    return next(err);
  }
});
