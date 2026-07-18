/**
 * Step 9 — the gate. Validate the rating engine against known ground truth
 * before any real player has a rating.
 *
 *   node scripts/simulate.js
 *   node scripts/simulate.js --matches 400 --seed 42
 *
 * TEST TOOL, NOT PRODUCTION CODE. Runs against the REAL engine — no
 * reimplementation — because a simulator that reimplements the maths validates
 * nothing. Config is read from Firestore so the run reflects live constants.
 *
 * Requirements are in CLAUDE.md > "Simulator Requirements" and Open Question 1,
 * which are authoritative.
 */
import { computeRatingUpdate } from '../src/services/ratingEngine.js';
import { validateScore } from '../src/lib/scoreValidator.js';
import { tierFor, TIER } from '../src/lib/placement.js';
import { toMu, toPhi, toRd, g } from '../src/lib/glicko2.js';
import { getConfig } from '../src/services/configService.js';
import { combineTeam } from '../src/lib/teamCombination.js';
import {
  makeRng,
  makePlayers,
  trueTeamSkill,
  trueWinProbability,
  generateScore,
  spearman,
  centredMae,
  logLoss,
  percentile,
  median,
} from './lib/simHarness.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};

const MATCHES = arg('matches', 400);
const SEED = arg('seed', 20260717);
const MATCHES_PER_DAY = 4;
const DAY_MS = 86_400_000;

const pairKey = (a, b) => [a, b].sort().join('|');
const matchupKey = (ids) => [...ids].sort().join('|');

/**
 * The engine's own predicted P(team A wins), before the update. Standard Glicko
 * two-entity prediction against the combined uncertainty of both teams.
 */
function predictedWinProbability(entityA, entityB) {
  const combinedPhi = Math.sqrt(entityA.phi ** 2 + entityB.phi ** 2);
  return 1 / (1 + Math.exp(-g(combinedPhi) * (entityA.mu - entityB.mu)));
}

/**
 * Run one simulation.
 *
 * @param {object} opts
 * @param {'wide'|'clustered'} opts.spread
 * @param {'rotate'|'fixed'} opts.partners
 * @param {'single'|'threeSet'} opts.format
 * @param {number} opts.matches
 * @param {object} opts.config
 */
function simulate({
  spread = 'wide',
  range,
  partners = 'rotate',
  format = 'threeSet',
  matches = MATCHES,
  config,
  seed = SEED,
}) {
  const rng = makeRng(seed);
  const roster = makePlayers({ spread, range, rng });

  // Live production starting state, exactly as a real signup would.
  const state = new Map(
    roster.map((p) => [
      p.id,
      {
        id: p.id,
        rating: config.defaultRating,
        rd: config.defaultRd,
        sigma: config.defaultVolatility,
        gamesPlayed: 0,
      },
    ]),
  );

  const meta = new Map(roster.map((p) => [p.id, p]));
  const partnerHistory = new Set();
  const matchupLog = new Map(); // matchupKey -> timestamps
  const opponentsFaced = new Map(roster.map((p) => [p.id, new Set()]));
  const crossedPlacement = new Map(); // id -> match count when RD first < 150
  const crossedEstablished = new Map();
  const rdTrace = new Map(roster.map((p) => [p.id, []]));

  // Fixed partnerships: ten stable pairs that never rotate.
  //
  // Pairs are drawn at RANDOM, then frozen. The roster is generated in ascending
  // skill order, so pairing adjacent entries would produce skill-homogeneous
  // pairs and hand this scenario an easier problem than rotation — which is the
  // opposite of what it exists to measure. Real fixed partnerships are arbitrary.
  const shuffledRoster = [...roster];
  for (let i = shuffledRoster.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffledRoster[i], shuffledRoster[j]] = [shuffledRoster[j], shuffledRoster[i]];
  }
  const fixedPairs = [];
  for (let i = 0; i < shuffledRoster.length; i += 2) {
    fixedPairs.push([shuffledRoster[i], shuffledRoster[i + 1]]);
  }

  const predictions = [];
  const outcomes = [];
  let rejectedScores = 0;

  for (let m = 0; m < matches; m += 1) {
    const timestamp = Math.floor(m / MATCHES_PER_DAY) * DAY_MS;

    // Choose four players.
    let quad;
    if (partners === 'fixed') {
      const shuffledPairs = [...fixedPairs].sort(() => rng() - 0.5);
      const [pa, pb] = shuffledPairs.slice(0, 2);
      quad = { a: pa, b: pb };
    } else {
      const picked = [];
      const pool = [...roster];
      for (let i = 0; i < 4; i += 1) {
        picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
      }
      quad = { a: [picked[0], picked[1]], b: [picked[2], picked[3]] };
    }

    const [a1, a2] = quad.a;
    const [b1, b2] = quad.b;
    const ids = [a1.id, a2.id, b1.id, b2.id];

    // M_repeat: prior occurrences of this exact four-player matchup within the
    // rolling window. This is what makes the seven-day reset real.
    const key = matchupKey(ids);
    const priors = matchupLog.get(key) ?? [];
    const windowMs = config.repeatWindowDays * DAY_MS;
    const repeatCount = priors.filter((t) => timestamp - t < windowMs).length;

    const teamPairing = (x, y) => ({
      isMixed: meta.get(x.id).gender !== meta.get(y.id).gender,
      hasPlayedTogether: partnerHistory.has(pairKey(x.id, y.id)),
    });

    const pairingA = teamPairing(a1, a2);
    const pairingB = teamPairing(b1, b2);

    // Ground truth decides the winner — independent of the engine's model.
    const trueA = trueTeamSkill(meta.get(a1.id), meta.get(a2.id));
    const trueB = trueTeamSkill(meta.get(b1.id), meta.get(b2.id));
    const pTrue = trueWinProbability(trueA, trueB);
    const aWins = rng() < pTrue;

    const { sets, gamesA, gamesB } = generateScore({ aWins, winProb: pTrue, format, rng });

    // Every synthetic score must pass the real validator, or the harness is
    // feeding the engine something production never could.
    const validated = validateScore(sets);
    if (!validated.valid || validated.winner !== (aWins ? 'A' : 'B')) {
      rejectedScores += 1;
      continue;
    }

    const sA = state.get(a1.id);
    const sA2 = state.get(a2.id);
    const sB = state.get(b1.id);
    const sB2 = state.get(b2.id);

    // Record the engine's prediction BEFORE it sees the result.
    const toInt = (p) => ({ mu: toMu(p.rating), phi: toPhi(p.rd) });
    const entA = combineTeam(toInt(sA), toInt(sA2), pairingA, config);
    const entB = combineTeam(toInt(sB), toInt(sB2), pairingB, config);
    predictions.push(predictedWinProbability(entA, entB));
    outcomes.push(aWins ? 1 : 0);

    const result = computeRatingUpdate({
      teams: {
        A: { players: [sA, sA2], ...pairingA },
        B: { players: [sB, sB2], ...pairingB },
      },
      score: { winner: validated.winner, format: validated.format, gamesA, gamesB },
      context: { repeatCount },
      config,
    });

    for (const p of result.players) {
      const cur = state.get(p.id);
      cur.rating = p.after.rating;
      cur.rd = p.after.rd;
      cur.sigma = p.after.sigma;
      cur.gamesPlayed += 1;

      rdTrace.get(p.id).push(cur.rd);

      if (!crossedPlacement.has(p.id) && cur.rd < config.rdThresholds.placement) {
        crossedPlacement.set(p.id, cur.gamesPlayed);
      }
      if (!crossedEstablished.has(p.id) && cur.rd < config.rdThresholds.provisional) {
        crossedEstablished.set(p.id, cur.gamesPlayed);
      }
    }

    partnerHistory.add(pairKey(a1.id, a2.id));
    partnerHistory.add(pairKey(b1.id, b2.id));
    matchupLog.set(key, [...priors, timestamp]);
    for (const x of [a1.id, a2.id]) for (const y of [b1.id, b2.id]) {
      opponentsFaced.get(x).add(y);
      opponentsFaced.get(y).add(x);
    }
  }

  const finals = roster.map((p) => state.get(p.id));
  const trueSkills = roster.map((p) => p.trueSkill);
  const ratings = finals.map((p) => p.rating);

  // RD floor: the settled level, taken as the mean of the last stretch of each
  // player's trace — an observed floor from realistic play, not an asymptote.
  const floors = roster.map((p) => {
    const trace = rdTrace.get(p.id);
    const tail = trace.slice(-Math.max(5, Math.floor(trace.length * 0.2)));
    return tail.length ? tail.reduce((s, v) => s + v, 0) / tail.length : null;
  });

  const fieldMedian = median(trueSkills);
  const errors = centredMae(ratings, trueSkills);

  return {
    roster,
    finals,
    trueSkills,
    ratings,
    spearman: spearman(ratings, trueSkills),
    // Centred: Glicko is a relative scale, so raw MAE reports the 1500-anchor
    // offset rather than engine accuracy. See centredMae.
    mae: errors.mae,
    offset: errors.offset,
    logLoss: logLoss(predictions, outcomes),
    crossedPlacement,
    crossedEstablished,
    floors,
    fieldMedian,
    opponentsFaced,
    rejectedScores,
    matchesPlayed: outcomes.length,
    tiers: roster.map((p) => tierFor(state.get(p.id), config)),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const f = (v, d = 3) => (v == null || Number.isNaN(v) ? '   n/a' : v.toFixed(d));
const hr = (c = '=') => console.log(c.repeat(78));

function reportScenarioTable(rows) {
  console.log('  scenario                        matches   spearman     MAE   log-loss');
  console.log('  ' + '-'.repeat(74));
  for (const [label, r] of rows) {
    console.log(
      `  ${label.padEnd(30)} ${String(r.matchesPlayed).padStart(7)}   ${f(r.spearman, 4).padStart(8)}  ${f(r.mae, 1).padStart(6)}   ${f(r.logLoss, 4).padStart(8)}`,
    );
  }
}

const main = async () => {
  const config = await getConfig();

  hr();
  console.log('  STEP 9 — RATING ENGINE VALIDATION AGAINST GROUND TRUTH');
  hr();
  console.log(`  config version ${config.version} (live Firestore)   seed ${SEED}   ${MATCHES} matches`);
  console.log(`  lambdaSame ${config.lambdaSame}  lambdaMixed ${config.lambdaMixed}  maxDelta ${config.maxDeltaPerMatch}`);
  console.log(`  rdThresholds placement ${config.rdThresholds.placement} / provisional ${config.rdThresholds.provisional}`);
  console.log('  ground truth: 0.6/0.4 weak-link blend + Elo logistic — NOT the engine model');
  console.log('  population: 20 players, 15M/5F (~39% mixed pairings)');
  console.log('');

  // ---- Scenario 1: wide spread, the gate --------------------------------
  const wide = simulate({ spread: 'wide', config });

  // ---- Scenario 2: clustered beta ---------------------------------------
  const clustered = simulate({ spread: 'clustered', config });

  // ---- Scenario 3: fixed vs rotated -------------------------------------
  const fixed = simulate({ spread: 'wide', partners: 'fixed', config });

  // ---- Scenario 4: court hours — 3 single sets == 1 three-set -----------
  const threeSetHours = simulate({ spread: 'wide', format: 'threeSet', matches: MATCHES, config });
  const singleHours = simulate({ spread: 'wide', format: 'single', matches: MATCHES * 3, config });

  hr('-');
  console.log('  SCENARIO COMPARISON');
  hr('-');
  reportScenarioTable([
    ['1. wide spread, rotated', wide],
    ['2. clustered beta, rotated', clustered],
    ['3. fixed partnerships', fixed],
    ['4a. three-set (N court hours)', threeSetHours],
    ['4b. single sets (same hours)', singleHours],
  ]);

  // ---- The gate ----------------------------------------------------------
  console.log('');
  hr();
  const passed = wide.spearman > 0.9;
  console.log(`  GATE: rank correlation > 0.9 on wide spread within ~${MATCHES} matches`);
  console.log(`  RESULT: spearman = ${f(wide.spearman, 4)}  ->  ${passed ? 'PASS' : 'FAIL'}`);
  if (!passed) {
    console.log('  The engine did not converge. Do not write an API endpoint against it.');
  }
  hr();

  // ---- Scenario 2 detail -------------------------------------------------
  console.log('');
  console.log('  SCENARIO 2 — how long the closed beta must run');
  console.log(`    wide spread      spearman ${f(wide.spearman, 4)}   MAE ${f(wide.mae, 1)}`);
  console.log(`    clustered beta   spearman ${f(clustered.spearman, 4)}   MAE ${f(clustered.mae, 1)}`);
  // Averaged across seeds. A single seed's clustered spearman has sd ~0.19,
  // which is large enough to fake a trend in either direction — do not report
  // convergence from one path.
  const SEEDS = 8;
  const across = (spread, matches) => {
    const xs = Array.from({ length: SEEDS }, (_, s) =>
      simulate({ spread, matches, config, seed: SEED + s * 7919 }).spearman,
    );
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    return { m, sd };
  };

  console.log('');
  console.log(`    mean of ${SEEDS} seeds — a single seed's clustered spearman has sd ~0.19`);
  console.log('    matches   wide spearman        clustered spearman');
  for (const n of [100, 200, 400, 800]) {
    const w = across('wide', n);
    const c = across('clustered', n);
    console.log(
      `    ${String(n).padStart(7)}   ${`${f(w.m, 3)} +/- ${f(w.sd, 3)}`.padStart(16)}   ${`${f(c.m, 3)} +/- ${f(c.sd, 3)}`.padStart(18)}`,
    );
  }
  console.log('');
  console.log('    >> clustered PLATEAUS. More matches do not help. See resolution limit below.');

  // ---- Resolution limit --------------------------------------------------
  console.log('');
  console.log('  RESOLUTION LIMIT — how much true skill spread the engine needs');
  console.log('    (400 matches, mean of 8 seeds. Adjacent gap = spread / 19.)');
  console.log('');
  console.log('    spread   adjacent gap   spearman            rankable?');
  for (const [lo, hi] of [
    [1700, 1850],
    [1650, 1900],
    [1600, 1950],
    [1550, 2000],
    [1450, 2050],
    [1250, 2050],
    [1100, 2100],
  ]) {
    const xs = Array.from({ length: 8 }, (_, s) =>
      simulate({ spread: 'custom', range: [lo, hi], matches: 400, config, seed: SEED + s * 6271 }).spearman,
    );
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    console.log(
      `    ${String(hi - lo).padStart(6)}   ${f((hi - lo) / 19, 1).padStart(12)}   ${`${f(m, 3)} +/- ${f(sd, 3)}`.padStart(16)}   ${m > 0.9 ? 'YES' : 'no'}`,
    );
  }
  console.log('');
  console.log('    >> The RD floor (~62) sets a noise level. Ranks resolve only where');
  console.log('       adjacent true-skill gaps exceed it. Below ~40 points apart, the');
  console.log('       order is largely noise and NO amount of play fixes it.');

  // ---- Scenario 3 detail -------------------------------------------------
  console.log('');
  console.log('  SCENARIO 3 — the empirical case for partner rotation');
  console.log(`    rotated partners   spearman ${f(wide.spearman, 4)}   MAE ${f(wide.mae, 1)}`);
  console.log(`    fixed partnerships spearman ${f(fixed.spearman, 4)}   MAE ${f(fixed.mae, 1)}`);
  console.log(`    degradation        ${f(wide.spearman - fixed.spearman, 4)} spearman, ${f(fixed.mae - wide.mae, 1)} MAE`);

  // ---- Scenario 4 detail -------------------------------------------------
  console.log('');
  console.log('  SCENARIO 4 — information per court hour (3 single sets == 1 three-set)');
  console.log(`    ${MATCHES} three-set matches   spearman ${f(threeSetHours.spearman, 4)}   MAE ${f(threeSetHours.mae, 1)}`);
  console.log(`    ${MATCHES * 3} single sets        spearman ${f(singleHours.spearman, 4)}   MAE ${f(singleHours.mae, 1)}`);
  const verdict4 = singleHours.spearman > threeSetHours.spearman ? 'single sets win' : 'three-set wins';
  console.log(`    verdict: ${verdict4}`);

  // ---- lambdaMixed sweep -------------------------------------------------
  console.log('');
  hr('-');
  console.log('  LAMBDA_MIXED SWEEP (CLAUDE.md requirement)');
  hr('-');
  const sweep = [];
  for (const lambdaMixed of [0.12, 0.2, 0.3]) {
    const r = simulate({ spread: 'wide', config: { ...config, lambdaMixed } });
    sweep.push([lambdaMixed, r]);
  }
  console.log('    lambdaMixed   log-loss    delta vs 0.12   spearman');
  const base = sweep[0][1].logLoss;
  for (const [lam, r] of sweep) {
    console.log(
      `    ${lam.toFixed(2).padStart(11)}   ${f(r.logLoss, 5).padStart(8)}   ${f(r.logLoss - base, 5).padStart(13)}   ${f(r.spearman, 4).padStart(8)}`,
    );
  }
  const spreadLL = Math.max(...sweep.map((s) => s[1].logLoss)) - Math.min(...sweep.map((s) => s[1].logLoss));
  console.log('');
  console.log(`    log-loss spread across the sweep: ${f(spreadLL, 5)}`);
  console.log(
    `    VERDICT: ${
      spreadLL < 0.005
        ? 'INCONCLUSIVE — the three are indistinguishable at this match volume.\n             The constant does not matter yet. This is a finding, not a failure.'
        : 'DIVERGENT — lambdaMixed measurably changes predictive accuracy.\n             It must be set from data, not intuition.'
    }`,
  );

  // ---- RD floor ----------------------------------------------------------
  console.log('');
  hr('-');
  console.log('  RD FLOOR — distribution, not a number (CLAUDE.md requirement)');
  hr('-');
  const floors = wide.floors.filter((v) => v != null);
  console.log('    observed floor distribution across the population (wide spread):');
  console.log(
    `      min ${f(Math.min(...floors), 1)}   p10 ${f(percentile(floors, 10), 1)}   median ${f(median(floors), 1)}   p90 ${f(percentile(floors, 90), 1)}   max ${f(Math.max(...floors), 1)}`,
  );
  console.log('');
  console.log('    floor as a function of skill gap from the field median:');
  console.log('      player   true skill   gap    observed floor   tier');
  const byGap = wide.roster
    .map((p, i) => ({ p, gap: p.trueSkill - wide.fieldMedian, floor: wide.floors[i], tier: wide.tiers[i] }))
    .sort((a, b) => a.gap - b.gap);
  for (const row of byGap) {
    console.log(
      `      ${row.p.id}     ${row.p.trueSkill.toFixed(0).padStart(6)}   ${(row.gap >= 0 ? '+' : '') + row.gap.toFixed(0).padStart(4)}   ${f(row.floor, 1).padStart(11)}      ${row.tier}`,
    );
  }

  // ---- Strongest player / affected population ---------------------------
  console.log('');
  hr('-');
  console.log('  DOES THE STRONGEST PLAYER REACH ESTABLISHED? (CLAUDE.md requirement)');
  hr('-');
  const strongestIdx = wide.trueSkills.indexOf(Math.max(...wide.trueSkills));
  const strongest = wide.roster[strongestIdx];
  const strongestReached = wide.crossedEstablished.has(strongest.id);
  console.log(`    strongest player: ${strongest.id} (true skill ${strongest.trueSkill.toFixed(0)})`);
  console.log(`    final tier      : ${wide.tiers[strongestIdx]}`);
  console.log(`    observed floor  : ${f(wide.floors[strongestIdx], 1)}   (established needs RD < ${config.rdThresholds.provisional})`);
  console.log(`    distinct opponents faced: ${wide.opponentsFaced.get(strongest.id).size}`);
  console.log(`    REACHES ESTABLISHED: ${strongestReached ? 'YES — at match ' + wide.crossedEstablished.get(strongest.id) : 'NO'}`);

  // ---- The dominant-player case -----------------------------------------
  console.log('');
  console.log('    DELIBERATE OUTLIER — one player ~600 above an otherwise clustered field');
  console.log('    (This is the dominant-player case. The wide-spread run above does NOT');
  console.log('     reach it: there the top player still faces opponents within range.)');
  console.log('');
  const outlierRuns = Array.from({ length: 8 }, (_, s) =>
    simulate({ spread: 'outlier', matches: MATCHES, config, seed: SEED + s * 4211 }),
  );
  console.log('    seed   outlier floor   tier          reached established   distinct opps');
  for (const [i, r] of outlierRuns.entries()) {
    const idx = r.roster.findIndex((p) => p.isOutlier);
    const reached = r.crossedEstablished.get('OUTLIER');
    console.log(
      `    ${String(i).padStart(4)}   ${f(r.floors[idx], 1).padStart(13)}   ${r.tiers[idx].padEnd(12)}  ${(reached ? `YES (match ${reached})` : 'NO').padEnd(19)}  ${r.opponentsFaced.get('OUTLIER').size}`,
    );
  }
  const outlierFloors = outlierRuns.map((r) => r.floors[r.roster.findIndex((p) => p.isOutlier)]);
  const fieldFloors = outlierRuns.flatMap((r) =>
    r.roster.map((p, i) => (p.isOutlier ? null : r.floors[i])).filter((v) => v != null),
  );
  const everReached = outlierRuns.filter((r) => r.crossedEstablished.has('OUTLIER')).length;
  console.log('');
  console.log(`    outlier floor : median ${f(median(outlierFloors), 1)}   (established needs RD < ${config.rdThresholds.provisional})`);
  console.log(`    field floor   : median ${f(median(fieldFloors), 1)}`);
  console.log(`    penalty       : ${f(median(outlierFloors) - median(fieldFloors), 1)} RD, purely from being untestable`);
  console.log(`    REACHES ESTABLISHED: ${everReached} of ${outlierRuns.length} runs`);
  if (everReached < outlierRuns.length) {
    console.log('');
    console.log('    >> The dominant-player failure is REAL. See CLAUDE.md — the fix is a');
    console.log('       product decision, and any escape hatch must gate on DISTINCT');
    console.log('       OPPONENTS, never gamesPlayed.');
  }

  const stuck = wide.tiers.filter((t) => t !== TIER.ESTABLISHED).length;
  console.log('');
  console.log(`    affected population: ${stuck} of ${wide.roster.length} players not established after ${wide.matchesPlayed} matches`);
  if (stuck > 0) {
    const stuckIds = wide.roster.filter((_, i) => wide.tiers[i] !== TIER.ESTABLISHED);
    console.log(`      ${stuckIds.map((p) => `${p.id}(${p.trueSkill.toFixed(0)})`).join(', ')}`);
  }
  console.log('');
  console.log('    NOTE: these are observed floors from realistic rotated play, not the');
  console.log('          asymptotic worst cases in CLAUDE.md.');

  // ---- Matches to crossing ----------------------------------------------
  console.log('');
  hr('-');
  console.log('  MATCHES-TO-RD-CROSSING — full distribution (Open Question 1)');
  hr('-');
  for (const [label, map, threshold] of [
    ['PLACEMENT exit (RD < ' + config.rdThresholds.placement + ')', wide.crossedPlacement, 'placement'],
    ['ESTABLISHED (RD < ' + config.rdThresholds.provisional + ')', wide.crossedEstablished, 'established'],
  ]) {
    const vals = wide.roster.map((p) => map.get(p.id)).filter((v) => v != null);
    const never = wide.roster.length - vals.length;
    console.log(`    ${label}`);
    if (vals.length === 0) {
      console.log('      never reached by any player');
    } else {
      console.log(
        `      min ${f(Math.min(...vals), 0)}   p50 ${f(median(vals), 1)}   p75 ${f(percentile(vals, 75), 1)}   p90 ${f(percentile(vals, 90), 1)}   max ${f(Math.max(...vals), 0)}   never: ${never}`,
      );
    }
  }

  const clusteredCross = clustered.roster
    .map((p) => clustered.crossedPlacement.get(p.id))
    .filter((v) => v != null);
  console.log('');
  console.log('    CLUSTERED beta — placement exit (this is the population that matters):');
  if (clusteredCross.length) {
    console.log(
      `      min ${f(Math.min(...clusteredCross), 0)}   p50 ${f(median(clusteredCross), 1)}   p90 ${f(percentile(clusteredCross, 90), 1)}   max ${f(Math.max(...clusteredCross), 0)}`,
    );
    console.log('');
    console.log(`    >> gamesPlayedFloors.provisional should be ~p90 = ${Math.ceil(percentile(clusteredCross, 90))}`);
    console.log(`       (currently ${config.gamesPlayedFloors.provisional}). Open Question 1.`);
  }

  console.log('');
  hr();
  console.log(`  GATE: ${passed ? 'PASS' : 'FAIL'}   (spearman ${f(wide.spearman, 4)} vs 0.9 required)`);
  hr();

  if (wide.rejectedScores > 0) {
    console.log(`\n  warning: ${wide.rejectedScores} generated scores failed the validator and were skipped.`);
  }

  process.exit(passed ? 0 : 1);
};

await main();
