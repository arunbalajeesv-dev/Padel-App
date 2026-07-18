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

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  // Health checks are the ONLY unauthenticated routes — Render probes them
  // without credentials.
  app.use(healthRouter);

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
