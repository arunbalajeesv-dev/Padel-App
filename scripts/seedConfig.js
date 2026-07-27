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
  //
  // lambdaMixed is deliberately launched EQUAL to lambdaSame. 0.20 is not known
  // to be wrong, but it is not known to be right either, and it is the only
  // constant encoding a claim about gender. Launching them equal means mixed and
  // same-gender pairs get an identical w, team rating, and credit split until
  // data says otherwise. The Step 9 simulator sweeps 0.12 / 0.20 / 0.30; raise
  // this from the result, not from intuition. See CLAUDE.md.
  lambdaSame: 0.12,
  lambdaMixed: 0.12,
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

  // The only cap in the system.
  //
  // maxDeltaPerMatch is a BUG BACKSTOP, not a shaping constraint. It must sit
  // above the worst LEGITIMATE delta, or it silently starts shaping real play.
  //
  // Placement players are exempt (see CLAUDE.md), so this only ever sees
  // provisional and established players. Worst legitimate case measured for a
  // provisional player at RD 149, partnered to maximise 2r, winning 6-0 6-0:
  //
  //   spread            lambdaMixed 0.12   lambdaMixed 0.20
  //   1300-1700              160.5              180.6
  //   1200-2000              185.7              209.7
  //   1000-2400              189.0              213.4
  //
  // 150 fired on legitimate play at every spread. 200 fires if the Step 9 sweep
  // concludes lambdaMixed = 0.20. 300 clears both branches with headroom while
  // still catching a catastrophic delta, which is orders of magnitude out.
  //
  // There is deliberately NO weeklyGainCap. It was deleted rather than sized: no
  // value works. Too low fires on a legitimate upset; too high is redundant
  // against maxDeltaPerMatch; nothing in between stops collusion, because a ring
  // paces itself under any cap a real streak survives. See CLAUDE.md > Resolved.
  maxDeltaPerMatch: 300,

  // Tier thresholds. A player must clear BOTH the RD bound and the games floor
  // to advance — the two are ANDed, never ORed.
  //
  //   placement    RD >= 250, or fewer than 3 games   (hidden from leaderboard)
  //   provisional  RD <  250 and >= 3 games
  //   established  RD <  100 and >= 10 games
  //
  // Bounds are STRICT: a player at exactly RD 250 is still in placement.
  //
  // LAUNCH ADJUSTMENT (not a Step-9 value). Placement exit was loosened from
  // "RD < 150 AND >= 8 games" to "RD < 250 AND >= 3 games" so players appear on
  // the leaderboard after ~3 confirmed matches instead of never (at 3 games RD
  // sits ~245, so the old RD<150 bound was the binding constraint and no one
  // crossed it early). This deliberately trades rating stability for a populated
  // board: early top ranks will shuffle noticeably as high-RD ratings converge.
  // Tighten back toward the Step-9 values once match volume makes an empty board
  // no longer a risk. Only the tier thresholds changed — the rating math is
  // untouched. See CLAUDE.md > "Tiers and Placement" and > Resolved.
  rdThresholds: {
    placement: 250,
    provisional: 100,
  },
  gamesPlayedFloors: {
    provisional: 3,
    established: 10,
  },

  // The 0-7 display scale. ratingDisplay is DERIVED from these on read and is
  // NEVER stored on the user document — a stored copy becomes a second source of
  // truth the moment this mapping is retuned, and every historical rating would
  // then disagree with the number printed beside it.
  //
  // Spans 1000-2500: ~1500 rating points across 7 units, ~214 points per unit.
  // How many digits of the result are honest to show is Open Question 1 — this
  // produces the value, not the rendering.
  displayScale: {
    ratingAtZero: 1000,
    ratingAtMax: 2500,
    maxUnits: 7,
  },

  // --- Operational thresholds (Step 15) ---------------------------------------

  // Weekly-gain admin alert. This SURFACES unusual gain for a human; it does not
  // cap or punish, so firing on legitimate play is harmless. 200 is deliberately
  // the value that was too low to CAP (it fired on legitimate 6-0 6-0 upsets —
  // see the deleted weeklyGainCap): a week that would have hit the old cap is
  // exactly a week worth a human glance. The endpoint returns distinctOpponents
  // alongside the gain, which is the real streak-vs-ring signal.
  weeklyGainAlertThreshold: 200,
  weeklyGainAlertWindowDays: 7,

  // trustScore is a shrunk mean of 1-5 sportsmanship scores, normalised to [0,1],
  // pulled toward a neutral 0.5 prior by this pseudocount. k=5 ≈ five reviews to
  // move halfway from neutral to the raw mean: stable early, responsive later.
  // See src/lib/trustScore.js. Never touches the skill rating.
  trustScorePriorWeight: 5,

  // Inactivity decay. A player unseen for longer than this many days has their RD
  // grown by one Glicko inactivity step per job run, capped at defaultRd — so
  // absence returns them toward newcomer uncertainty, never past it.
  inactivityThresholdDays: 30,
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
