import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import express from 'express';

import * as auctionNight from '../services/auctionNightService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, '..', '..', 'auction-night');

export const auctionNightRouter = Router();

// Creation lives under /admin now (src/routes/admin.js) — only an admin can
// start an auction. Everything below stays open: no player accounts here,
// participants get in with a link plus the PIN the admin hands out.

auctionNightRouter.get('/auction-night/api/auctions', async (req, res, next) => {
  try {
    const auctions = await auctionNight.listAuctions();
    return res.json({ auctions });
  } catch (err) {
    return next(err);
  }
});

auctionNightRouter.get('/auction-night/api/auctions/:id', async (req, res, next) => {
  try {
    const found = await auctionNight.getAuction(req.params.id);
    if (!found) return res.status(404).json({ error: 'Not Found' });
    return res.json({ auction: found });
  } catch (err) {
    return next(err);
  }
});

// PIN check: unauthenticated, deliberately generic on failure (no hint about
// which role a near-miss PIN belongs to). Returns which role tier the PIN
// unlocks — the client then only offers seats that role is allowed to take.
auctionNightRouter.post('/auction-night/api/auctions/:id/verify-pin', async (req, res, next) => {
  try {
    const { pin } = req.body || {};
    if (typeof pin !== 'string' || !/^\d{4}$/.test(pin.trim())) {
      return res.status(400).json({ error: 'Bad Request', reason: 'pin must be a 4-digit string.' });
    }
    const role = await auctionNight.verifyPin(req.params.id, pin);
    if (!role) return res.status(401).json({ error: 'Unauthorized', reason: 'incorrect PIN' });
    return res.json({ role });
  } catch (err) {
    return next(err);
  }
});

auctionNightRouter.post('/auction-night/api/auctions/:id', async (req, res, next) => {
  try {
    const { expectedRev, state } = req.body || {};
    if (typeof expectedRev !== 'number' || typeof state !== 'object' || state === null || Array.isArray(state)) {
      return res.status(400).json({
        error: 'Bad Request',
        reason: 'Body must be { expectedRev: number, state: object }.',
      });
    }

    const result = await auctionNight.writeAuctionState(req.params.id, expectedRev, state);
    if (result.notFound) return res.status(404).json({ error: 'Not Found' });
    if (result.conflict) return res.status(409).json({ error: 'Conflict', auction: result.auction });
    return res.json({ auction: result.auction });
  } catch (err) {
    return next(err);
  }
});

// Clean shareable URLs: /auction-night/a/<id> always serves the same SPA
// shell, which reads the id off the URL itself. Registered before the static
// middleware so it isn't shadowed by the directory listing.
auctionNightRouter.get('/auction-night/a/:id', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'auction.html'));
});

auctionNightRouter.use('/auction-night', express.static(STATIC_DIR));
