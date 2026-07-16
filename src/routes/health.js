import { Router } from 'express';

import { getFirestore } from '../config/firebase.js';

export const healthRouter = Router();

const DB_TIMEOUT_MS = 5000;

healthRouter.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

healthRouter.get('/health/db', async (req, res) => {
  const startedAt = Date.now();

  try {
    // A doc read round-trips to Firestore and exercises the credential. The doc
    // is not expected to exist; `exists: false` still proves the link is alive.
    const read = getFirestore().collection('_health').doc('ping').get();

    const timeout = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`Firestore read exceeded ${DB_TIMEOUT_MS}ms`)),
        DB_TIMEOUT_MS,
      ).unref();
    });

    await Promise.race([read, timeout]);

    res.json({
      status: 'ok',
      firestore: 'connected',
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'error',
      firestore: 'unreachable',
      reason: err.message,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  }
});
