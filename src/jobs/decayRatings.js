/**
 * Inactivity decay job.
 *
 * A player unseen for longer than `inactivityThresholdDays` has their RD grown
 * by one Glicko-2 inactivity step per run — we are less certain about someone we
 * have not watched play. Rating (µ) and volatility are untouched; only RD moves,
 * and only upward. See glicko2.js `applyInactivity`.
 *
 * Two things this job must NOT do:
 *   - It must not touch `lastActiveAt`. Decaying is not activity; resetting the
 *     clock would stop a player ever decaying again.
 *   - It must not push RD past `defaultRd`. Absence returns a player toward
 *     newcomer uncertainty (350), never beyond it.
 *
 * Every change writes a `ratingHistory` entry (reason `inactivity`, matchId
 * null, rating unchanged) so the RD move is auditable exactly like a match move.
 *
 * RUN MODES, chosen by env var:
 *   - standalone:  `node src/jobs/decayRatings.js`  (for an external scheduler)
 *   - in-process:  set DECAY_SCHEDULE to a cron expression and the Express app
 *                  schedules it via node-cron. Render's cron pricing may push us
 *                  to this; the same code path runs either way.
 */
import { pathToFileURL } from 'node:url';

import { getFirestore } from '../config/firebase.js';
import { getConfig } from '../services/configService.js';
import { USERS_COLLECTION } from '../services/usersService.js';
import { RATING_HISTORY_COLLECTION } from '../services/confirmationService.js';
import { toMu, toPhi, toRd, applyInactivity } from '../lib/glicko2.js';

const DAY_MS = 86_400_000;

/**
 * The RD a player's rating would inflate to after one inactivity step, capped at
 * `defaultRd`. Pure.
 *
 * @param {{value: number, rd: number, sigma: number}} rating Stored, display-scale.
 * @param {object} config Needs defaultRd.
 * @returns {number} the new (display-scale) RD, always >= the current RD.
 */
export function decayedRd(rating, config) {
  const inflated = applyInactivity({
    mu: toMu(rating.value),
    phi: toPhi(rating.rd),
    sigma: rating.sigma,
  });
  return Math.min(toRd(inflated.phi), config.defaultRd);
}

/**
 * Grow RD for every inactive player, auditing each change.
 *
 * @param {{config: object, now?: number}} input
 * @returns {Promise<{scanned: number, decayed: number, cutoff: string}>}
 */
export async function runDecay({ config, now = Date.now() }) {
  const db = getFirestore();
  const cutoff = new Date(now - config.inactivityThresholdDays * DAY_MS).toISOString();
  const nowIso = new Date(now).toISOString();

  // Single-field range — served by the automatic index, no composite needed.
  const snap = await db
    .collection(USERS_COLLECTION)
    .where('lastActiveAt', '<', cutoff)
    .get();

  let decayed = 0;

  for (const doc of snap.docs) {
    // Per-player transaction: the RD update and its audit entry land together or
    // not at all, and the re-read guards against a match confirmed since the scan.
    const applied = await db.runTransaction(async (tx) => {
      const ref = db.collection(USERS_COLLECTION).doc(doc.id);
      const cur = await tx.get(ref);
      if (!cur.exists) return false;

      const user = cur.data();
      const rdBefore = user.rating.rd;
      const rdAfter = decayedRd(user.rating, config);

      // Already at the cap (or a race left it there): nothing to decay, and no
      // audit entry for a non-change.
      if (!(rdAfter > rdBefore)) return false;

      // Only RD changes. lastActiveAt is deliberately untouched.
      tx.update(ref, { rating: { ...user.rating, rd: rdAfter } });
      tx.create(ref.collection(RATING_HISTORY_COLLECTION).doc(), {
        matchId: null,
        reason: 'inactivity',
        ratingBefore: user.rating.value,
        ratingAfter: user.rating.value,
        rdBefore,
        rdAfter,
        configVersion: config.version,
        createdAt: nowIso,
      });
      return true;
    });

    if (applied) decayed += 1;
  }

  return { scanned: snap.size, decayed, cutoff };
}

/**
 * Schedule the job in-process if DECAY_SCHEDULE is set. Returns the node-cron
 * task, or null when no schedule is configured (the standalone script is then
 * expected to run under an external scheduler).
 *
 * node-cron is imported lazily so the app does not depend on it unless this mode
 * is actually used.
 */
export async function startDecayCron({ schedule = process.env.DECAY_SCHEDULE } = {}) {
  if (!schedule) return null;

  const cron = (await import('node-cron')).default;
  if (!cron.validate(schedule)) {
    throw new Error(`decayRatings: DECAY_SCHEDULE is not a valid cron expression: ${schedule}`);
  }

  const task = cron.schedule(schedule, async () => {
    try {
      const config = await getConfig();
      const result = await runDecay({ config });
      console.log('[decay] run complete', result);
    } catch (err) {
      console.error('[decay] run failed', err);
    }
  });

  console.log(`[decay] in-process schedule active: ${schedule}`);
  return task;
}

/** Standalone entry point: `node src/jobs/decayRatings.js`. */
async function main() {
  const config = await getConfig();
  const result = await runDecay({ config });
  console.log('[decay] standalone run complete', result);
  process.exit(0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[decay] standalone run failed', err);
    process.exit(1);
  });
}
