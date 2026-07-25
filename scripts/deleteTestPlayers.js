/**
 * Delete every seeded TEST player — Auth user AND Firestore document — so test
 * data never leaks into a real launch.
 *
 *   node scripts/deleteTestPlayers.js            # DRY RUN: list, delete nothing
 *   node scripts/deleteTestPlayers.js --confirm  # actually delete
 *
 * The dry run is the default ON PURPOSE. This script deletes accounts, and it
 * must be impossible to wipe them by a stray invocation — so it does nothing
 * destructive without the explicit `--confirm` flag.
 *
 * It removes a player only if they are tagged `isTestPlayer` (see
 * seedTestPlayers.js). It finds them two ways, so a half-created player cannot
 * survive:
 *
 *   1. every Firestore document with `isTestPlayer == true` (and its Auth user)
 *   2. every Auth user carrying the `isTestPlayer` custom claim (catching an
 *      Auth user whose document is missing)
 *
 * A real player, having neither the flag nor the claim, is never touched.
 */
import { getAuth, getFirestore } from '../src/config/firebase.js';
import { USERS_COLLECTION } from '../src/services/usersService.js';
import { TEST_PLAYER_FLAG } from './testPlayerFlag.js';

/** Every Auth uid carrying the test-player custom claim, across all pages. */
async function taggedAuthUids() {
  const auth = getAuth();
  const uids = new Set();
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.customClaims?.[TEST_PLAYER_FLAG] === true) uids.add(user.uid);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return uids;
}

async function main() {
  const confirmed = process.argv.includes('--confirm');
  const db = getFirestore();
  const auth = getAuth();

  // Gather from both sides and union, so a half-created player is still caught.
  const docSnap = await db.collection(USERS_COLLECTION).where(TEST_PLAYER_FLAG, '==', true).get();
  const docUids = docSnap.docs.map((d) => ({ uid: d.id, name: d.data().name ?? '(no name)' }));

  const claimUids = await taggedAuthUids();

  const targets = new Map();
  for (const { uid, name } of docUids) targets.set(uid, name);
  for (const uid of claimUids) if (!targets.has(uid)) targets.set(uid, '(auth only — no document)');

  if (targets.size === 0) {
    console.log('No test players found. Nothing to delete.');
    process.exit(0);
  }

  console.log(`Found ${targets.size} test player(s) tagged ${TEST_PLAYER_FLAG}:\n`);
  for (const [uid, name] of targets) console.log(`  ${uid}  ${name}`);

  if (!confirmed) {
    console.log(
      `\nDRY RUN — nothing deleted. Re-run with --confirm to remove all ${targets.size}.`,
    );
    process.exit(0);
  }

  console.log(`\nDeleting ${targets.size} test player(s) …\n`);
  let removed = 0;
  for (const [uid, name] of targets) {
    // Delete the document first, then the Auth user. Best-effort on each so one
    // missing half does not strand the other.
    await db.collection(USERS_COLLECTION).doc(uid).delete().catch(() => {});
    await auth.deleteUser(uid).catch((err) => {
      if (err?.code !== 'auth/user-not-found') throw err;
    });
    removed += 1;
    console.log(`  ✓ removed ${uid}  ${name}`);
  }

  console.log(`\nDeleted ${removed} test player(s).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nDeletion failed:', err.message);
  process.exit(1);
});
