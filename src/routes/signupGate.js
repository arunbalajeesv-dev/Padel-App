import { Router } from 'express';

import { hasActiveCode, findActiveCode } from '../services/inviteCodesService.js';

/**
 * The soft-launch invite gate, checkable BEFORE phone auth.
 *
 * ---------------------------------------------------------------------------
 * THIS ROUTER IS DELIBERATELY UNAUTHENTICATED, and mounted above the blanket
 * requireAuth. That is the entire point: it lets the client ask "is a code
 * needed, and is this one valid?" before burning an SMS on someone who will
 * be turned away at profile creation anyway.
 *
 * IT IS NOT THE ENFORCEMENT POINT. The real gate is in signupRouter's
 * POST /users, which re-checks the code against a VERIFIED token. Anyone can
 * call these routes, or skip them entirely; that buys nothing, because a
 * profile still cannot be created without a valid code. Treat these as a
 * courtesy to honest users, never as a security boundary.
 * ---------------------------------------------------------------------------
 */
export const signupGateRouter = Router();

/**
 * Best-effort brute-force throttle. In memory, so it resets on deploy and is
 * per-instance rather than global — it slows down casual guessing, and is not
 * claimed to do more. The codes themselves are shared in a group chat, so
 * their secrecy is low by design; the real control is that a wrong guess
 * still cannot create a profile.
 */
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 20;
const attempts = new Map(); // ip -> { count, resetAt }

function throttled(ip) {
  const now = Date.now();
  const record = attempts.get(ip);

  if (!record || now > record.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return false;
  }
  record.count += 1;
  return record.count > MAX_ATTEMPTS;
}

// Unbounded growth would be a slow leak on a long-lived process; sweep the
// expired entries occasionally rather than tracking every IP forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of attempts) if (now > record.resetAt) attempts.delete(ip);
}, ATTEMPT_WINDOW_MS).unref();

/**
 * Whether signup currently needs an invite code at all. Lets the client show
 * the right screen instead of guessing — and means turning the gate off (by
 * deactivating the last code) needs no client redeploy.
 */
signupGateRouter.get('/signup/gate', async (req, res, next) => {
  try {
    return res.json({ inviteRequired: await hasActiveCode() });
  } catch (err) {
    return next(err);
  }
});

/**
 * Check one code. Answers only yes/no — never which codes exist, never the
 * phase or any other stored field.
 */
signupGateRouter.post('/signup/gate', async (req, res, next) => {
  try {
    if (throttled(req.ip)) {
      return res.status(429).json({
        error: 'Too Many Requests',
        reason: 'Too many tries. Wait a few minutes and try again.',
      });
    }

    const { code } = req.body ?? {};
    if (typeof code !== 'string' || code.trim().length === 0) {
      return res.status(400).json({ error: 'Bad Request', reason: 'code is required.' });
    }

    // An open gate accepts anything — the client should not be showing this
    // screen at all, but answering "valid" is the truthful answer to "will
    // this stop me signing up?", which is what the caller is really asking.
    if (!(await hasActiveCode())) return res.json({ valid: true });

    const found = await findActiveCode(code);
    if (!found) {
      return res.status(403).json({
        error: 'Forbidden',
        reason: 'That invite code is not valid.',
      });
    }

    return res.json({ valid: true });
  } catch (err) {
    return next(err);
  }
});
