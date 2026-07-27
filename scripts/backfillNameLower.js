/**
 * Backfill `nameLower` onto every existing user document.
 *
 *   node scripts/backfillNameLower.js            # write the missing/changed ones
 *   node scripts/backfillNameLower.js --dry-run  # report only, write nothing
 *
 * `nameLower` is a lowercased+trimmed copy of `name` that makes player search
 * case-insensitive (see usersService.searchUsers). New users get it at signup;
 * this script gives it to everyone created before the field existed — the six
 * seeded players and the real accounts — so they become searchable.
 *
 * Idempotent: a document whose `nameLower` already equals the folded name is
 * skipped, so re-running is safe and cheap.
 */
import { getFirestore } from '../src/config/firebase.js';
import { USERS_COLLECTION } from '../src/services/usersService.js';

const BATCH_LIMIT = 400; // Firestore caps a batch at 500; stay well under.

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = getFirestore();

  const snap = await db.collection(USERS_COLLECTION).get();

  let updated = 0;
  let alreadyCorrect = 0;
  let noName = 0;
  let batch = db.batch();
  let inBatch = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (typeof data.name !== 'string' || data.name.trim() === '') {
      noName += 1;
      continue;
    }

    const nameLower = data.name.trim().toLowerCase();
    if (data.nameLower === nameLower) {
      alreadyCorrect += 1;
      continue;
    }

    updated += 1;
    if (!dryRun) {
      batch.update(doc.ref, { nameLower });
      inBatch += 1;
      if (inBatch >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        inBatch = 0;
      }
    }
  }

  if (!dryRun && inBatch > 0) await batch.commit();

  console.log(
    `${snap.size} user(s) scanned.\n` +
      `  ${updated} ${dryRun ? 'would be updated' : 'updated'}\n` +
      `  ${alreadyCorrect} already correct\n` +
      `  ${noName} skipped (no usable name)`,
  );
  if (dryRun) console.log('\n--dry-run: nothing written.');
}

await main();
process.exit(0);
