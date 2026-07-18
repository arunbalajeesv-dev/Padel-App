/**
 * Admin dashboard statistics.
 *
 * Computed in memory from full-collection reads. At ~100 players and a modest
 * match volume this is cheap and keeps the queries index-free; if the club grows
 * into the thousands, move the counts to Firestore aggregation (`.count()`) and
 * the histogram to a maintained rollup. Documented so that is a deliberate future
 * step, not a surprise.
 */
import { getFirestore } from '../config/firebase.js';
import { USERS_COLLECTION } from './usersService.js';
import { MATCHES_COLLECTION, STATUS } from './matchesService.js';
import { DISPUTES_COLLECTION, DISPUTE_STATUS } from './disputesService.js';

const DAY_MS = 86_400_000;

/** A player counts as active if seen within this many days. Reported alongside. */
const ACTIVE_WINDOW_DAYS = 30;

/** RD histogram buckets, width 50 up to the default (max) RD of 350. */
const RD_BUCKET_WIDTH = 50;
const RD_MAX = 350;

function rdHistogram(users) {
  const buckets = [];
  for (let min = 0; min < RD_MAX; min += RD_BUCKET_WIDTH) {
    buckets.push({ min, max: min + RD_BUCKET_WIDTH, label: `${min}-${min + RD_BUCKET_WIDTH}`, count: 0 });
  }

  for (const u of users) {
    const rd = u.rating?.rd;
    if (typeof rd !== 'number' || !Number.isFinite(rd)) continue;
    // Clamp into range: RD can sit exactly at 350, and nothing legitimately
    // exceeds it, but a stray value should still land somewhere.
    const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor(rd / RD_BUCKET_WIDTH)));
    buckets[idx].count += 1;
  }

  return buckets;
}

/**
 * @returns {Promise<object>} totals plus the RD histogram, ready for charting.
 */
export async function adminStats() {
  const db = getFirestore();
  const now = Date.now();
  const activeCutoff = new Date(now - ACTIVE_WINDOW_DAYS * DAY_MS).toISOString();
  const weekCutoff = new Date(now - 7 * DAY_MS).toISOString();

  const [usersSnap, matchesSnap, disputesSnap] = await Promise.all([
    db.collection(USERS_COLLECTION).get(),
    db.collection(MATCHES_COLLECTION).get(),
    db.collection(DISPUTES_COLLECTION).get(),
  ]);

  const users = usersSnap.docs.map((d) => d.data());
  const matches = matchesSnap.docs.map((d) => d.data());
  const disputes = disputesSnap.docs.map((d) => d.data());

  const liveDispute = new Set([DISPUTE_STATUS.OPEN, DISPUTE_STATUS.NEEDS_ADMIN_REVIEW]);

  const confirmed = matches.filter((m) => m.status === STATUS.CONFIRMED);

  return {
    totalMatches: matches.length,
    confirmedMatches: confirmed.length,
    activePlayers: users.filter((u) => (u.lastActiveAt ?? '') >= activeCutoff).length,
    activeWindowDays: ACTIVE_WINDOW_DAYS,
    totalPlayers: users.length,
    pendingDisputes: disputes.filter((d) => liveDispute.has(d.status)).length,
    matchesThisWeek: confirmed.filter((m) => (m.playedAt ?? '') >= weekCutoff).length,
    rdHistogram: rdHistogram(users),
  };
}
