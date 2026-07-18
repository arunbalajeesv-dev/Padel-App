import { getFirestore } from '../config/firebase.js';

export const CONFIG_COLLECTION = 'config';
export const CONFIG_DOC = 'rating';

// Short enough that a config change lands within a minute; long enough that a
// burst of match submissions costs one read, not one per match.
const CACHE_TTL_MS = 60_000;

// Every constant the rating engine depends on. There are deliberately no
// fallback defaults: a missing key is a misconfigured deployment, and silently
// substituting a value would hardcode a constant and produce ratings stamped
// with a config version that does not describe them.
const REQUIRED_NUMBERS = [
  'version',
  'tau',
  'defaultRating',
  'defaultRd',
  'defaultVolatility',
  'lambdaSame',
  'lambdaMixed',
  'gapScaleD',
  'synergy.same.repeat',
  'synergy.same.firstTime',
  'synergy.mixed.repeat',
  'synergy.mixed.firstTime',
  'formatSingleSet',
  'formatThreeSet',
  'marginBase',
  'marginCoefficient',
  'repeatWindowDays',
  'maxDeltaPerMatch',
  'rdThresholds.placement',
  'rdThresholds.provisional',
  'gamesPlayedFloors.provisional',
  'gamesPlayedFloors.established',
  'displayScale.ratingAtZero',
  'displayScale.ratingAtMax',
  'displayScale.maxUnits',

  // Operational (Step 15). Not rating-math constants — they shape no delta, so
  // adding them does not invalidate ratingHistory replay. They still live here
  // and still throw when missing, because a deployment missing an alert or decay
  // threshold is misconfigured and should fail loudly, not run on a guess.
  'weeklyGainAlertThreshold',
  'weeklyGainAlertWindowDays',
  'trustScorePriorWeight',
  'inactivityThresholdDays',
];

function valueAt(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function validate(data) {
  const problems = [];

  for (const path of REQUIRED_NUMBERS) {
    const value = valueAt(data, path);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${path} must be a finite number (got ${JSON.stringify(value)})`);
    }
  }

  const { repeatMultipliers } = data;
  if (!Array.isArray(repeatMultipliers) || repeatMultipliers.length === 0) {
    problems.push('repeatMultipliers must be a non-empty array');
  } else if (!repeatMultipliers.every((m) => typeof m === 'number' && Number.isFinite(m))) {
    problems.push('repeatMultipliers must contain only finite numbers');
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid rating config at ${CONFIG_COLLECTION}/${CONFIG_DOC}:\n  - ` +
        problems.join('\n  - ') +
        '\nRun `node scripts/seedConfig.js` to write a valid config.',
    );
  }

  return data;
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

let cached = null;
let pending = null;

/**
 * Read the rating config, memoised for CACHE_TTL_MS.
 *
 * Concurrent callers during a cache miss share one Firestore read rather than
 * stampeding — four players' deltas for one match resolve against a single doc.
 *
 * @param {{ force?: boolean }} [options] force bypasses the cache.
 * @returns {Promise<Readonly<object>>} the frozen config document.
 */
export async function getConfig({ force = false } = {}) {
  if (!force && cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  if (!force && pending) return pending;

  pending = (async () => {
    const snap = await getFirestore()
      .collection(CONFIG_COLLECTION)
      .doc(CONFIG_DOC)
      .get();

    if (!snap.exists) {
      throw new Error(
        `Rating config not found at ${CONFIG_COLLECTION}/${CONFIG_DOC}. ` +
          'Run `node scripts/seedConfig.js` to create it.',
      );
    }

    const value = deepFreeze(validate(snap.data()));
    cached = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/**
 * The config version currently in force. Every ratingHistory entry must record
 * this alongside the delta it produced, so past ratings can be replayed against
 * the constants that actually produced them.
 *
 * @returns {Promise<number>}
 */
export async function getConfigVersion() {
  return (await getConfig()).version;
}

/** Drop the memoised config. For tests and for post-write invalidation. */
export function invalidateConfigCache() {
  cached = null;
  pending = null;
}
