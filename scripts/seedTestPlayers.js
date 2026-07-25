/**
 * Seed fully-formed TEST players for development.
 *
 *   node scripts/seedTestPlayers.js        # create 6 (the default)
 *   node scripts/seedTestPlayers.js 20     # create 20
 *
 * Each player is created EXACTLY as real signup would produce them:
 *
 *   1. a Firebase Auth user with a fake-but-valid-format phone number, and
 *   2. a Firestore profile created through `usersService.createUser` — the same
 *      code path POST /users uses — so the document carries the server-assigned
 *      defaults (placement status, gamesPlayed 0, starting rating, NO
 *      trustScore) and is byte-identical to a real signup.
 *
 * The one addition is a marker: every seeded player is tagged `isTestPlayer:
 * true` on the document AND with a matching Auth custom claim, so
 * `deleteTestPlayers.js` can find and remove every one — Auth user and document
 * both — before a real launch. See that script.
 *
 * The marker is applied as a follow-up write, NOT threaded through createUser,
 * precisely so the profile createUser produces stays identical to production.
 */
import { pathToFileURL } from 'node:url';

import { getAuth, getFirestore } from '../src/config/firebase.js';
import { getConfig } from '../src/services/configService.js';
import { createUser, USERS_COLLECTION } from '../src/services/usersService.js';
import { TEST_PLAYER_FLAG } from './testPlayerFlag.js';

const DEFAULT_COUNT = 6;

// Chennai-appropriate names, split so we can guarantee a mix of genders — the
// men's, women's and open leaderboards all need people to show anything.
const MALE_NAMES = [
  'Arjun Ramesh', 'Karthik Subramanian', 'Vikram Nair', 'Ravi Shankar',
  'Siddharth Iyer', 'Rahul Menon', 'Vijay Krishnan', 'Aravind Kumar',
  'Surya Prakash', 'Naveen Balaji', 'Ganesh Rajan', 'Hari Venkat',
];
const FEMALE_NAMES = [
  'Priya Raghavan', 'Ananya Krishnan', 'Meena Sundaram', 'Divya Narayan',
  'Lakshmi Rao', 'Nithya Balan', 'Kavya Mohan', 'Deepa Srinivasan',
  'Sowmya Ravi', 'Aishwarya Pillai', 'Janani Murali', 'Revathi Chandran',
];

const AREAS = [
  'Adyar', 'Anna Nagar', 'Besant Nagar', 'ECR', 'Mylapore', 'Nungambakkam',
  'OMR', 'Perungudi', 'Porur', 'T. Nagar', 'Thoraipakkam', 'Velachery',
];

/** A fake but E.164-valid Indian mobile: +91 9######### with a random suffix. */
function randomTestPhone() {
  const nineDigits = String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0');
  return `+919${nineDigits}`;
}

/**
 * Create one player: Auth user first (so the uid is Firebase-issued, as in real
 * signup), then the profile keyed by that uid. If the profile write fails, the
 * Auth user is rolled back so no orphan is left.
 */
async function seedOne({ name, gender, area, config, index }) {
  const auth = getAuth();

  // Retry on the vanishingly rare phone collision rather than aborting the batch.
  let authUser;
  for (let attempt = 0; attempt < 5 && !authUser; attempt += 1) {
    try {
      authUser = await auth.createUser({ phoneNumber: randomTestPhone() });
    } catch (err) {
      if (err?.code !== 'auth/phone-number-already-exists' || attempt === 4) throw err;
    }
  }

  const uid = authUser.uid;

  try {
    // The real signup path. Input is filtered to CREATABLE_FIELDS inside.
    await createUser({
      uid,
      phone: authUser.phoneNumber,
      input: { name, gender, area },
      config,
    });

    // Mark as test data, on BOTH sides. The document flag drives the normal
    // cleanup query; the custom claim lets the deleter also catch an Auth user
    // whose document somehow went missing.
    await getFirestore().collection(USERS_COLLECTION).doc(uid).update({ [TEST_PLAYER_FLAG]: true });
    await auth.setCustomUserClaims(uid, { [TEST_PLAYER_FLAG]: true });

    return { uid, name, gender, area, phone: authUser.phoneNumber };
  } catch (err) {
    // Roll back the Auth user so a failed profile write leaves nothing behind.
    await auth.deleteUser(uid).catch(() => {});
    throw new Error(`Failed to seed "${name}" (index ${index}): ${err.message}`);
  }
}

/** Build the roster: alternate genders so both gendered boards get players. */
function roster(count) {
  const players = [];
  for (let i = 0; i < count; i += 1) {
    const male = i % 2 === 0;
    const pool = male ? MALE_NAMES : FEMALE_NAMES;
    const nameIndex = Math.floor(i / 2) % pool.length;
    players.push({
      name: pool[nameIndex],
      gender: male ? 'M' : 'F',
      area: AREAS[i % AREAS.length],
    });
  }
  return players;
}

async function main() {
  const arg = process.argv[2];
  const count = arg === undefined ? DEFAULT_COUNT : Number(arg);

  if (!Number.isInteger(count) || count < 1 || count > 200) {
    console.error(`Count must be an integer from 1 to 200 (got ${JSON.stringify(arg)}).`);
    process.exit(1);
  }

  const config = await getConfig();

  console.log(`Seeding ${count} test player(s), tagged ${TEST_PLAYER_FLAG}: true …\n`);

  const created = [];
  for (const [index, spec] of roster(count).entries()) {
    const player = await seedOne({ ...spec, config, index });
    created.push(player);
    console.log(`  ✓ ${player.name.padEnd(24)} ${player.gender}  ${player.area.padEnd(14)} ${player.uid}`);
  }

  const men = created.filter((p) => p.gender === 'M').length;
  console.log(
    `\nCreated ${created.length}: ${men} men, ${created.length - men} women.\n` +
      `Remove them with:  node scripts/deleteTestPlayers.js --confirm`,
  );
  process.exit(0);
}

// Only run when invoked directly — never when imported for a constant.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('\nSeeding failed:', err.message);
    process.exit(1);
  });
}
