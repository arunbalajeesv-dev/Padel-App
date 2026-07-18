/**
 * Simulation harness internals — synthetic population, ground truth, metrics.
 *
 * TEST TOOL, NOT PRODUCTION CODE. Nothing here is imported by src/.
 *
 * The ground-truth model here is deliberately NOT the engine's model. If the
 * outcome generator used the engine's own weak-link tanh formula, the simulator
 * would be testing the engine against itself and rank correlation would be
 * inflated by construction. Ground truth uses a fixed 0.6/0.4 weak-link blend
 * and an Elo-style logistic — a plausible physical claim the engine must
 * discover approximately, not a copy of its own arithmetic.
 */

/** Deterministic RNG (mulberry32) so every run is reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffle = (arr, rng) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * Twenty synthetic players with a hidden true skill.
 *
 * Gender is assigned 15M/5F, matching the recorded observation that the Chennai
 * padel community skews male. Without genders there are no mixed pairs and the
 * lambdaMixed sweep returns three identical numbers — a null result caused by
 * the harness rather than a finding.
 */
export function makePlayers({ count = 20, spread = 'wide', range, rng }) {
  const ranges = {
    wide: [1100, 2100],
    clustered: [1700, 1850],
  };

  // The dominant-player case: a field that is otherwise clustered, plus one
  // player far above it. This is the configuration where every match the
  // outlier plays is a foregone conclusion, so their matches carry almost no
  // information and their RD floor rises. A wide-spread run does NOT reach this
  // case — there the top player still faces opponents within range.
  if (spread === 'outlier') {
    const [lo, hi] = ranges.clustered;
    const n = count - 1;
    const field = Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
    const fieldMedian = (lo + hi) / 2;

    return [...field, fieldMedian + 600].map((trueSkill, i) => ({
      id: i === count - 1 ? 'OUTLIER' : `p${String(i + 1).padStart(2, '0')}`,
      trueSkill,
      gender: i < Math.round(count * 0.75) ? 'M' : 'F',
      isOutlier: i === count - 1,
    }));
  }

  const [lo, hi] = range ?? ranges[spread] ?? ranges.wide;

  return Array.from({ length: count }, (_, i) => ({
    id: `p${String(i + 1).padStart(2, '0')}`,
    trueSkill: lo + ((hi - lo) * i) / (count - 1),
    gender: i < Math.round(count * 0.75) ? 'M' : 'F',
    isOutlier: false,
  }));
}

/**
 * Ground-truth team strength: a fixed weak-link blend.
 *
 * NOT the engine's formula. The engine must approximate this from results.
 */
export function trueTeamSkill(a, b) {
  const weak = Math.min(a.trueSkill, b.trueSkill);
  const strong = Math.max(a.trueSkill, b.trueSkill);
  return 0.6 * weak + 0.4 * strong;
}

/** Elo-style logistic. Closer true skills give closer to a coin flip. */
export function trueWinProbability(teamATrue, teamBTrue) {
  return 1 / (1 + 10 ** (-(teamATrue - teamBTrue) / 400));
}

const LEGAL_ENDINGS = [
  [6, 0],
  [6, 1],
  [6, 2],
  [6, 3],
  [6, 4],
  [7, 5],
  [7, 6],
];

/**
 * A legal set score whose decisiveness tracks the skill gap.
 *
 * Index 0 (6-0) is most dominant, index 6 (7-6) is closest. A gaussian over the
 * ending index, centred by dominance, keeps scores plausible rather than uniform.
 */
function sampleSetEnding(dominance, rng) {
  const target = (1 - dominance) * (LEGAL_ENDINGS.length - 1);
  const weights = LEGAL_ENDINGS.map((_, i) => Math.exp(-((i - target) ** 2) / 2.0));
  const total = weights.reduce((s, w) => s + w, 0);

  let r = rng() * total;
  for (let i = 0; i < weights.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return LEGAL_ENDINGS[i];
  }
  return LEGAL_ENDINGS[LEGAL_ENDINGS.length - 1];
}

/**
 * A plausible score consistent with the skill gap.
 *
 * @returns {{sets: Array<{teamA: number, teamB: number}>, gamesA: number, gamesB: number}}
 */
export function generateScore({ aWins, winProb, format, rng }) {
  const dominance = Math.min(1, Math.abs(winProb - 0.5) * 2);

  const setFor = (winnerIsA) => {
    const [hi, lo] = sampleSetEnding(dominance, rng);
    return winnerIsA ? { teamA: hi, teamB: lo } : { teamA: lo, teamB: hi };
  };

  let sets;
  if (format === 'single') {
    sets = [setFor(aWins)];
  } else {
    // A dominant favourite is likelier to win in straight sets.
    const straight = rng() < 0.5 + 0.4 * dominance;
    sets = straight
      ? [setFor(aWins), setFor(aWins)]
      : shuffle([setFor(aWins), setFor(!aWins)], rng).concat(setFor(aWins));

    if (!straight) {
      // Ensure the decider is last and the first two are split.
      sets = [setFor(aWins), setFor(!aWins), setFor(aWins)];
      if (rng() < 0.5) sets = [setFor(!aWins), setFor(aWins), setFor(aWins)];
    }
  }

  const gamesA = sets.reduce((s, x) => s + x.teamA, 0);
  const gamesB = sets.reduce((s, x) => s + x.teamB, 0);
  return { sets, gamesA, gamesB };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function rank(values) {
  const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation. */
export function spearman(x, y) {
  const rx = rank(x);
  const ry = rank(y);
  const n = x.length;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / n;
  const mx = mean(rx);
  const my = mean(ry);

  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/** Mean absolute error. */
export function mae(a, b) {
  return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
}

/**
 * MAE after removing the mean offset between the two scales.
 *
 * Glicko is a RELATIVE scale with no external anchor: in a closed pool the mean
 * rating stays near the 1500 starting point regardless of the population's true
 * skill. Raw MAE against a population whose true mean is 1775 therefore reports
 * ~275 of pure offset and tells you nothing about engine accuracy. Centring
 * measures what we actually care about — the spread of the error, not where the
 * scale happens to sit.
 *
 * @returns {{mae: number, offset: number}}
 */
export function centredMae(ratings, trueSkills) {
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const offset = mean(ratings) - mean(trueSkills);
  return {
    mae: mae(ratings.map((r) => r - offset), trueSkills),
    offset,
  };
}

/** Binary log-loss, clamped to avoid infinities. */
export function logLoss(predictions, outcomes) {
  const eps = 1e-15;
  const n = predictions.length;
  if (n === 0) return NaN;

  return (
    -predictions.reduce((s, p, i) => {
      const q = Math.min(1 - eps, Math.max(eps, p));
      return s + (outcomes[i] * Math.log(q) + (1 - outcomes[i]) * Math.log(1 - q));
    }, 0) / n
  );
}

/** Percentile of a numeric array (linear interpolation). */
export function percentile(values, p) {
  const sorted = [...values].filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const median = (v) => percentile(v, 50);
