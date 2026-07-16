/**
 * Seed the rating config document.
 *
 *   node scripts/seedConfig.js           # write if absent, refuse to clobber
 *   node scripts/seedConfig.js --force   # overwrite (see warning below)
 *
 * These constants are reasoned starting estimates, not values derived from real
 * padel data. They must be tuned by offline replay once ~300 real matches exist.
 * See CLAUDE.md.
 *
 * On --force: ratingHistory entries stamp the config version that produced them.
 * Editing a version's values in place breaks that guarantee, because history
 * will point at constants that no longer match. To retune, write a NEW version
 * rather than forcing over an existing one.
 */
import { getFirestore } from '../src/config/firebase.js';
import { CONFIG_COLLECTION, CONFIG_DOC } from '../src/services/configService.js';

const CONFIG_V1 = {
  version: 1,

  // Glicko-2 system constants
  tau: 0.5,
  defaultRating: 1500,
  defaultRd: 350,
  defaultVolatility: 0.06,

  // Weak-link team combination: w = 0.5 + lambda * tanh(d / gapScaleD)
  lambdaSame: 0.12,
  lambdaMixed: 0.20,
  gapScaleD: 1.15,

  // Team uncertainty synergy term, by pairing type and familiarity.
  synergy: {
    same: { repeat: 0.10, firstTime: 0.17 },
    mixed: { repeat: 0.17, firstTime: 0.23 },
  },

  // Format multiplier, derived from set count — never player-selected.
  formatSingleSet: 0.65,
  formatThreeSet: 1.0,

  // M_margin = marginBase + marginCoefficient * sqrt(ratio)
  marginBase: 0.8,
  marginCoefficient: 0.4,

  // M_repeat by prior identical matchups within repeatWindowDays.
  // Index 0 = first meeting. Counts beyond the array clamp to the last entry.
  repeatMultipliers: [1.0, 0.7, 0.4, 0.2],
  repeatWindowDays: 7,

  // Anti-abuse caps
  maxDeltaPerMatch: 150,
  weeklyGainCap: 200,

  // RD tiers: > placement = placement (hidden from public leaderboard),
  // > provisional = provisional, at or below provisional = established.
  rdThresholds: {
    placement: 200,
    provisional: 100,
  },
};

async function main() {
  const force = process.argv.includes('--force');
  const db = getFirestore();
  const ref = db.collection(CONFIG_COLLECTION).doc(CONFIG_DOC);

  const existing = await ref.get();

  if (existing.exists && !force) {
    const current = existing.data();
    console.error(
      `Refusing to overwrite existing config at ${CONFIG_COLLECTION}/${CONFIG_DOC} ` +
        `(version ${current.version}).\n` +
        'ratingHistory entries reference config versions; rewriting one in place ' +
        'breaks replay.\nTo retune, write a new version. To overwrite anyway, ' +
        'pass --force.',
    );
    process.exitCode = 1;
    return;
  }

  await ref.set({ ...CONFIG_V1, updatedAt: new Date().toISOString() });

  console.log(
    `Wrote ${CONFIG_COLLECTION}/${CONFIG_DOC} version ${CONFIG_V1.version}` +
      (existing.exists ? ' (overwrote existing)' : ''),
  );
}

await main();
process.exit(process.exitCode ?? 0);
