/**
 * Recompute every user's stored `status` from the current tier thresholds.
 *
 *   node scripts/recomputeStatus.js            # rewrite statuses that changed
 *   node scripts/recomputeStatus.js --dry-run  # report only, write nothing
 *
 * `status` is written by `tierFor` at confirmation time and stored on the user
 * document — it is NOT recomputed on read. So when the tier thresholds in config
 * change (e.g. the launch loosening of placement exit), existing players keep
 * their stale status until they next play. The leaderboard filters on the stored
 * value, so the config change has no visible effect on already-rated players
 * until their status is re-derived.
 *
 * This applies the change: it reads each user's rd + gamesPlayed, recomputes the
 * tier from the LIVE config, and rewrites `status` where it differs. It touches
 * nothing else — not the rating, not lastActiveAt. Idempotent.
 *
 * This is NOT rating math. `status` is a classification of (rd, gamesPlayed)
 * against thresholds; recomputing it only propagates a threshold change.
 */
import { getFirestore } from '../src/config/firebase.js';
import { getConfig } from '../src/services/configService.js';
import { USERS_COLLECTION } from '../src/services/usersService.js';
import { tierFor } from '../src/lib/placement.js';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = getFirestore();
  const config = await getConfig();

  const snap = await db.collection(USERS_COLLECTION).get();

  const changes = [];
  for (const doc of snap.docs) {
    const u = doc.data();
    if (!u.rating || typeof u.rating.rd !== 'number' || typeof u.gamesPlayed !== 'number') {
      continue; // malformed doc — leave it alone
    }
    const next = tierFor({ rd: u.rating.rd, gamesPlayed: u.gamesPlayed }, config);
    if (next !== u.status) {
      changes.push({ ref: doc.ref, id: doc.id, name: u.name, from: u.status, to: next });
    }
  }

  console.log(
    `${snap.size} user(s) scanned against config v${config.version} ` +
      `(placement RD < ${config.rdThresholds.placement}, ` +
      `floor ${config.gamesPlayedFloors.provisional} games).\n`,
  );

  if (changes.length === 0) {
    console.log('No status changes needed.');
    return;
  }

  for (const c of changes) {
    console.log(`  ${c.name ?? c.id}: ${c.from} -> ${c.to}`);
  }

  if (dryRun) {
    console.log(`\n--dry-run: ${changes.length} status change(s) NOT written.`);
    return;
  }

  const batch = db.batch();
  for (const c of changes) batch.update(c.ref, { status: c.to });
  await batch.commit();

  console.log(`\nRewrote ${changes.length} status(es).`);
}

await main();
process.exit(0);
