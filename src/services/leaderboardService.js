/**
 * Leaderboards.
 *
 * ---------------------------------------------------------------------------
 * USER-LEVEL FILTERS. NO MATCH DATA IS READ.
 *
 * Three pools: men's, women's, open. All three are simple queries against the
 * `users` collection. Men's and women's filter by gender; open is every player,
 * unfiltered.
 *
 * There is NO mixed pool. `matchPool` was deleted, and a mixed tab cannot be
 * built correctly regardless: we keep one latent rating per player, so no
 * mixed-specific rating exists to rank. See CLAUDE.md > Leaderboards.
 * ---------------------------------------------------------------------------
 *
 * SORTING: by the STORED rating, never by the display value.
 *
 * `toDisplayRating` CLAMPS to [0, maxUnits]. The map is monotonic but not
 * strictly so — every player above `ratingAtMax` displays 7.0. Sorting by the
 * display value would therefore tie everyone at the top of the ladder and order
 * them arbitrarily, which is exactly where ordering matters most and where the
 * community's own knowledge of the true order is strongest.
 *
 * (`ratingDisplay` is also derived-never-stored, so Firestore could not sort by
 * it in any case. The clamp is the reason it would still be wrong if it could.)
 */
import { getFirestore } from '../config/firebase.js';
import { getConfig } from './configService.js';
import { USERS_COLLECTION } from './usersService.js';
import { RATING_HISTORY_COLLECTION } from './confirmationService.js';
import { toDisplayRating } from '../lib/displayRating.js';
import { TIER } from '../lib/placement.js';

export const POOLS = Object.freeze(['men', 'women', 'open']);

export const PERIODS = Object.freeze(['7d', '30d', 'all']);

export const MOVEMENT = Object.freeze({ UP: 'up', DOWN: 'down', FLAT: 'flat' });

/** Open is deliberately absent: it applies no gender filter at all. */
const GENDER_FOR_POOL = Object.freeze({ men: 'M', women: 'F' });

const PERIOD_DAYS = Object.freeze({ '7d': 7, '30d': 30, all: null });

/**
 * Placement players are NEVER on the leaderboard. This is the allowlist that
 * enforces it — an `in` filter rather than `status != placement`, because a `!=`
 * is an inequality and Firestore would force it to be the first sort field,
 * which would stop us ordering by rating at all.
 */
const VISIBLE_TIERS = Object.freeze([TIER.PROVISIONAL, TIER.ESTABLISHED]);

/** The club is ~100 players. A bound anyway: an unbounded query is a footgun. */
const MAX_ENTRIES = 200;

const DAY_MS = 86_400_000;

/**
 * Which way a player's rating has moved across the period.
 *
 * Reads that player's own `ratingHistory`, which is user data, not match data —
 * the leaderboard still reads no `matches` document. The rating at the start of
 * the window is the `ratingBefore` of their earliest entry inside it.
 *
 * No entries in the window means they have not played in it, so their rating has
 * not moved: FLAT. That is a fact, not an estimate.
 */
async function movementFor(db, player, period) {
  const days = PERIOD_DAYS[period];

  let query = db
    .collection(USERS_COLLECTION)
    .doc(player.id)
    .collection(RATING_HISTORY_COLLECTION);

  if (days !== null) {
    query = query.where('createdAt', '>=', new Date(Date.now() - days * DAY_MS).toISOString());
  }

  const snap = await query.orderBy('createdAt', 'asc').limit(1).get();
  if (snap.empty) return MOVEMENT.FLAT;

  const ratingAtStart = snap.docs[0].data().ratingBefore;
  const delta = player.rating.value - ratingAtStart;

  if (delta > 0) return MOVEMENT.UP;
  if (delta < 0) return MOVEMENT.DOWN;
  return MOVEMENT.FLAT;
}

/**
 * Build a leaderboard.
 *
 * @param {{pool?: string, area?: string|null, period?: string}} input
 * @returns {Promise<object[]>} Ranked entries. Public fields only — no rating
 *   internals, no status, no gamesPlayed, no trustScore, no phone.
 */
export async function getLeaderboard({ pool = 'open', area = null, period = '30d' } = {}) {
  const db = getFirestore();
  const config = await getConfig();

  let query = db.collection(USERS_COLLECTION).where('status', 'in', VISIBLE_TIERS);

  const gender = GENDER_FOR_POOL[pool];
  if (gender) query = query.where('gender', '==', gender);
  if (area) query = query.where('area', '==', area);

  // The stored rating. See the note at the top of this file.
  const snap = await query.orderBy('rating.value', 'desc').limit(MAX_ENTRIES).get();

  const players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // One small read per listed player. At ~100 players that is cheap; if the
  // club grows enough for it to hurt, precompute movement rather than dropping
  // it — an arrow nobody can trust is worse than no arrow.
  const movements = await Promise.all(players.map((p) => movementFor(db, p, period)));

  return players.map((player, index) => ({
    rank: index + 1,
    id: player.id,
    name: player.name,
    area: player.area ?? null,
    ratingDisplay: toDisplayRating(player.rating.value, config),
    movement: movements[index],
  }));
}
