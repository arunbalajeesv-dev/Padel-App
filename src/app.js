import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { healthRouter } from './routes/health.js';
import { signupRouter, usersRouter } from './routes/users.js';
import { courtsRouter } from './routes/courts.js';
import { matchesRouter } from './routes/matches.js';
import { feedbackRouter } from './routes/feedback.js';
import { leaderboardRouter } from './routes/leaderboard.js';
import { adminRouter } from './routes/admin.js';
import { requireAuth } from './middleware/auth.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_PANEL_DIR = path.join(__dirname, '..', 'admin-panel');

/**
 * The strict default everywhere else in the API.
 */
const strictHelmet = helmet();

/**
 * Relaxed ONLY for /admin-panel's static shell, which signs in via Firebase
 * phone auth directly in the browser (same mechanism the React client uses,
 * just without a bundler) — that needs the Firebase SDK from a CDN, its
 * network calls to Google's identity endpoints, and the invisible reCAPTCHA
 * iframe, none of which the default `script-src 'self'` / `connect-src`
 * fallback permits. Scoped to this one path so the rest of the JSON API keeps
 * the strict default untouched.
 */
const adminPanelHelmet = helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", 'https://www.gstatic.com', 'https://www.google.com', 'https://www.recaptcha.net'],
      'connect-src': ["'self'", 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com'],
      'frame-src': ['https://chennai-padel.firebaseapp.com', 'https://www.google.com', 'https://www.recaptcha.net'],
    },
  },
});

export function createApp() {
  const app = express();

  // Exactly one of these runs per request — see the two consts above for why
  // /admin-panel needs a different policy than everything else.
  app.use((req, res, next) => {
    const helmetForPath = req.path.startsWith('/admin-panel') ? adminPanelHelmet : strictHelmet;
    return helmetForPath(req, res, next);
  });
  app.use(cors());
  app.use(express.json());

  // Health checks and the admin panel's static shell are the only
  // unauthenticated routes. Render probes health without credentials; the
  // admin panel is a public page (like any login screen) whose OWN script
  // then authenticates every API call it makes with a real bearer token —
  // nothing behind requireAdmin becomes reachable without one. See
  // admin-panel/app.js.
  app.use(healthRouter);
  app.use('/admin-panel', express.static(ADMIN_PANEL_DIR));

  // ONE deliberate exception to blanket auth: POST /users, first-time signup.
  // The caller has a verified token and no profile yet, so requireAuth would
  // 403 them and signup would be unreachable. signupRouter applies
  // requireVerifiedToken itself and contains exactly this one route.
  app.use(signupRouter);

  // Everything below this line requires a valid token AND an existing profile.
  // Mount new routers below, never above.
  app.use(requireAuth);

  app.use(usersRouter);
  app.use(courtsRouter);
  app.use(matchesRouter);
  app.use(feedbackRouter);
  app.use(leaderboardRouter);
  // Mounted UNDER /admin so its blanket requireAdmin only guards the admin
  // subtree. Mounting it unprefixed would run requireAdmin on every request —
  // including unknown paths, which would then 403 instead of 404.
  app.use('/admin', adminRouter);

  // Reached only by authenticated callers, so an unknown path 404s for members
  // and 401s for everyone else — an anonymous caller cannot enumerate routes.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
