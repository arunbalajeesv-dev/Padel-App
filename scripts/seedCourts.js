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
// The real Chennai padel venues. This is the production directory, not test
// data — these persist into launch and carry NO throwaway marker.
//
// Each court is name + area only. `address` is not collected yet (stored null),
// and `isPartner` is false until a venue actually has a commercial arrangement —
// exactly what createCourt would write for a court given only name and area, so
// these documents are byte-identical to one created through POST /courts.
//
//   name      — as players say it; this is what they pick from a list.
//   area      — the GROUPING KEY for the leaderboard's area filter. Keep these
//               spelled consistently, because GET /courts?area= is an exact-match
//               query — a typo makes a court invisible to the filter.
//
// Two venues are named "Ballpark" in different areas (Kottivakkam and
// Arumbakkam). They are DISTINCT courts and must stay two documents — the dedup
// key below is name+area, so both are kept, not collapsed by name.
//
// Courts gate match submission (CLAUDE.md > Anti-Abuse Rules): a match requires
// that its court exists here, so completeness matters.
// ===========================================================================
const COURTS = [
  { name: '7Padel', area: 'Palavakkam' },
  { name: 'PRC', area: 'Vadapalani' },
  { name: 'Padlr', area: 'Palavakkam' },
  { name: 'Madras Rally', area: 'Velachery' },
  { name: 'Ballpark', area: 'Kottivakkam' },
  { name: 'Ballpark', area: 'Arumbakkam' },
  { name: 'Neighbourhood Nets', area: 'Alwarpet' },
  { name: 'Serv', area: 'T Nagar' },
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
