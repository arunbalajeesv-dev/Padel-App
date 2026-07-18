/**
 * Seed the courts collection.
 *
 *   node scripts/seedCourts.js           # add courts that don't exist yet
 *   node scripts/seedCourts.js --dry-run # print what would be written
 *
 * Idempotent: matches on name + area, so re-running does not duplicate. Existing
 * courts are left untouched rather than overwritten — a court id may already be
 * referenced by played matches.
 */
import { getFirestore } from '../src/config/firebase.js';
import { COURTS_COLLECTION } from '../src/services/courtsService.js';

// ===========================================================================
// TODO(arun): fill in the real Chennai padel venues.
//
// The entries below are PLACEHOLDERS with invented addresses. They are here to
// show the shape and to let the endpoint be exercised end-to-end. Replace them
// wholesale — do not launch on these.
//
// For each venue you need:
//   name      — as players say it, since this is what they pick from a list
//   address   — free text; shown, never parsed
//   area      — the GROUPING KEY for the leaderboard's area filter. Keep these
//               consistent ("Nungambakkam", not "nungambakkam" / "Nungambakam"),
//               because GET /courts?area= is an exact-match query. A typo makes
//               a court invisible to the filter.
//   isPartner — true only for venues with a commercial arrangement.
//
// Courts gate match submission (CLAUDE.md > Anti-Abuse Rules): a match requires
// that its court exists here. A missing venue means those players cannot log
// matches at all, so completeness matters more than tidiness.
// ===========================================================================
const COURTS = [
  { name: 'PLACEHOLDER — Padel Park Chennai', address: 'TODO', area: 'Nungambakkam', isPartner: false },
  { name: 'PLACEHOLDER — Smash Padel Club', address: 'TODO', area: 'Velachery', isPartner: false },
  { name: 'PLACEHOLDER — The Padel Court OMR', address: 'TODO', area: 'OMR', isPartner: false },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = getFirestore();

  const existing = await db.collection(COURTS_COLLECTION).get();
  const seen = new Set(
    existing.docs.map((d) => `${d.data().name}|${d.data().area}`.toLowerCase()),
  );

  const toAdd = COURTS.filter((c) => !seen.has(`${c.name}|${c.area}`.toLowerCase()));

  if (COURTS.some((c) => c.name.startsWith('PLACEHOLDER'))) {
    console.warn('WARNING: placeholder courts present. Fill in the real venue list.\n');
  }

  console.log(`${existing.size} court(s) already present, ${toAdd.length} to add.`);

  if (toAdd.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  for (const c of toAdd) console.log(`  + ${c.name} (${c.area})`);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const batch = db.batch();
  const now = new Date().toISOString();
  for (const c of toAdd) {
    batch.set(db.collection(COURTS_COLLECTION).doc(), {
      name: c.name,
      address: c.address ?? null,
      area: c.area,
      isPartner: c.isPartner === true,
      createdAt: now,
    });
  }
  await batch.commit();

  console.log(`\nWrote ${toAdd.length} court(s).`);
}

await main();
process.exit(0);
