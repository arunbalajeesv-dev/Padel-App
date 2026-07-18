/**
 * Match confirmation — the point where a match becomes a rating.
 *
 * A match affects nothing until at least one player from EACH team has
 * confirmed. That is the rule, and it is not "all four": requiring four
 * signatures would let one absent player freeze a result indefinitely, while one
 * per side already means no team can be scored without its own consent.
 *
 * ---------------------------------------------------------------------------
 * ATOMIC AND IDEMPOTENT
 *
 * Everything below runs inside ONE Firestore transaction: the confirmation, the
 * four rating updates, the four history entries, and the match status. A partial
 * apply is the worst outcome available here — a player whose rating moved with no
 * history entry to explain it, or a match marked confirmed whose deltas never
 * landed, is unauditable and unrepairable.
 *
 * Idempotency is guarded by `status`, checked INSIDE the transaction. Two
 * concurrent confirmations serialize; the second reads the first's write, sees
 * `confirmed`, and returns without applying anything. A double confirmation must
 * never apply ratings twice.
 *
 * Firestore requires all reads before any write. Every read below therefore
 * happens up front, and nothing is read after the first tx.update.
 * ---------------------------------------------------------------------------
 *
 * NOTE ON EXPOSURE: the deltas and multipliers written to the match document are
 * an AUDIT record for the admin console. They must never reach the browser —
 * `toMatchView` is an allowlist and deliberately omits every field written here.
 * See CLAUDE.md: no rating formula, constant, or intermediate value ships to the
 * client.
 */
import { getFirestore } from '../config/firebase.js';
import { getConfig } from './configService.js';
import { computeRatingUpdate } from './ratingEngine.js';
import { tierFor } from '../lib/placement.js';
import {
  MATCHES_COLLECTION,
  STATUS,
  confirmationState,
  playersOf,
  pairKey,
  matchupKeyFor,
} from './matchesService.js';
import { USERS_COLLECTION } from './usersService.js';

/** Per-player subcollection: users/{uid}/ratingHistory/{autoId}. */
export const RATING_HISTORY_COLLECTION = 'ratingHistory';

const DAY_MS = 86_400_000;

const httpError = (status, error, reason) =>
  Object.assign(new Error(reason), { status, error, reason });

/**
 * Map a user document to the engine's player shape.
 *
 * The stored field is `rating.value`, a DISPLAY-scale rating (1500) — NOT a
 * Glicko-2 µ. The engine converts to internal scale itself via toMu(). Glicko µ
 * exists only inside glicko2.js and never reaches storage; see CLAUDE.md.
 * `gamesPlayed` is required because it decides tier, and tier decides cap
 * exemption.
 */
const enginePlayer = (id, user) => ({
  id,
  rating: user.rating.value,
  rd: user.rating.rd,
  sigma: user.rating.sigma,
  gamesPlayed: user.gamesPlayed,
});

/**
 * Confirm a match, applying ratings if this confirmation completes the rule.
 *
 * @param {{matchId: string, uid: string}} input
 * @returns {Promise<{match: object, applied: boolean}>} `applied` is true only on
 *   the confirmation that actually ran the pipeline.
 */
export async function confirmMatch({ matchId, uid }) {
  const db = getFirestore();

  // Read outside the transaction: config is immutable per version — retuning
  // writes a NEW version — so it cannot drift underneath us mid-transaction.
  const config = await getConfig();

  return db.runTransaction(async (tx) => {
    const matchRef = db.collection(MATCHES_COLLECTION).doc(matchId);
    const snap = await tx.get(matchRef);

    if (!snap.exists) throw httpError(404, 'Not Found', 'no such match');

    const match = { id: snap.id, ...snap.data() };
    const players = playersOf(match);

    if (!players.includes(uid)) {
      throw httpError(403, 'Forbidden', 'You can only confirm a match you played in.');
    }

    // The ratings already landed. Returning the match rather than an error is
    // deliberate: a double confirmation is a retry or a double-tap, not a
    // mistake the player should be scolded for.
    if (match.status === STATUS.CONFIRMED) return { match, applied: false };

    if (match.status !== STATUS.PENDING) {
      throw httpError(409, 'Conflict', `a ${match.status} match cannot be confirmed`);
    }

    // Already signed. Also a no-op — and the guard that stops one player
    // reaching the both-teams rule on their own.
    if ((match.confirmedBy ?? []).includes(uid)) return { match, applied: false };

    const confirmedBy = [...(match.confirmedBy ?? []), uid];
    const confirmed = { ...match, confirmedBy };

    // THE RULE: one player from each team. Not all four.
    if (!confirmationState(confirmed).isFullyConfirmed) {
      tx.update(matchRef, { confirmedBy });
      return { match: confirmed, applied: false };
    }

    // ---------------------------------------------------------------- reads --

    const userRefs = players.map((id) => db.collection(USERS_COLLECTION).doc(id));
    const userSnaps = await tx.getAll(...userRefs);

    const absent = userSnaps.filter((s) => !s.exists);
    if (absent.length > 0) {
      throw httpError(409, 'Conflict', 'a player on this match no longer exists');
    }

    const users = new Map(userSnaps.map((s) => [s.id, s.data()]));
    const sides = { A: match.teamA, B: match.teamB };

    // Has this PAIR partnered before? Per team — never the match. A team's
    // familiarity is a property of its own two players.
    const togetherSnaps = await Promise.all(
      ['A', 'B'].map((side) =>
        tx.get(
          db
            .collection(MATCHES_COLLECTION)
            .where('pairs', 'array-contains', pairKey(...sides[side]))
            .where('status', '==', STATUS.CONFIRMED)
            .limit(1),
        ),
      ),
    );

    // M_repeat: prior confirmed occurrences of this exact four-player matchup
    // within the window. Strictly before this match's playedAt, so it counts
    // what came first rather than whatever happens to be confirmed already.
    const windowStart = new Date(
      Date.parse(match.playedAt) - config.repeatWindowDays * DAY_MS,
    ).toISOString();

    const repeatSnap = await tx.get(
      db
        .collection(MATCHES_COLLECTION)
        .where('matchupKey', '==', match.matchupKey ?? matchupKeyFor(players))
        .where('status', '==', STATUS.CONFIRMED)
        .where('playedAt', '>=', windowStart)
        .where('playedAt', '<', match.playedAt),
    );
    const repeatCount = repeatSnap.size;

    // -------------------------------------------------------------- compute --

    const teams = {};
    for (const side of ['A', 'B']) {
      const [first, second] = sides[side];
      teams[side] = {
        players: [
          enginePlayer(first, users.get(first)),
          enginePlayer(second, users.get(second)),
        ],
        // Derived from THIS team's two players. There is no match-level gender
        // classification, and team B never inherits team A's pairing type.
        isMixed: users.get(first).gender !== users.get(second).gender,
        hasPlayedTogether: !togetherSnaps[side === 'A' ? 0 : 1].empty,
      };
    }

    const update = computeRatingUpdate({
      teams,
      score: {
        winner: match.winner,
        format: match.format,
        gamesA: match.gamesA,
        gamesB: match.gamesB,
      },
      context: { repeatCount },
      config,
    });

    // --------------------------------------------------------------- writes --

    const now = new Date().toISOString();

    for (const player of update.players) {
      const user = users.get(player.id);
      const gamesPlayed = user.gamesPlayed + 1;
      const userRef = db.collection(USERS_COLLECTION).doc(player.id);

      tx.update(userRef, {
        rating: {
          value: player.after.rating,
          rd: player.after.rd,
          sigma: player.after.sigma,
        },
        gamesPlayed,
        status: tierFor({ rd: player.after.rd, gamesPlayed }, config),
        lastActiveAt: now,
      });

      // Auto-id generated client-side, so it is available inside a transaction.
      tx.create(userRef.collection(RATING_HISTORY_COLLECTION).doc(), {
        matchId: match.id,
        ratingBefore: player.before.rating,
        ratingAfter: player.after.rating,
        rdBefore: player.before.rd,
        rdAfter: player.after.rd,
        // The stamp that makes replay possible. Never omit it.
        configVersion: update.configVersion,
        createdAt: now,
      });
    }

    // Step 8 auditability: store the DERIVED values, not merely the inputs.
    // At launch config lambdaMixed == lambdaSame, so a mis-derived pairingType
    // changes no rating anyone can see — these fields are the only witness that
    // the seam is wired correctly.
    const pairing = {};
    for (const side of ['A', 'B']) {
      const entity = update.teams[side];
      pairing[side] = {
        pairingType: teams[side].isMixed ? 'mixed' : 'same',
        w: entity.w,
        // The weak link's uid, not 'A'/'B' — an index into a pair is not an
        // audit record anyone can read without reconstructing the call.
        weakLink: sides[side][entity.weakLink === 'A' ? 0 : 1],
        hasPlayedTogether: teams[side].hasPlayedTogether,
      };
    }

    tx.update(matchRef, {
      status: STATUS.CONFIRMED,
      confirmedBy,
      confirmedAt: now,
      configVersion: update.configVersion,
      multipliers: update.multipliers,
      repeatCount,
      pairing,
      ratingDeltas: update.players.map((player) => ({
        playerId: player.id,
        team: player.team,
        tier: player.tier,
        isWeakLink: player.isWeakLink,
        rawDelta: player.rawDelta,
        multipliers: player.multipliers,
        informativeness: player.informativeness,
        scaledDelta: player.scaledDelta,
        finalDelta: player.finalDelta,
        capped: player.capped,
        capExempt: player.capExempt,
        ratingBefore: player.before.rating,
        ratingAfter: player.after.rating,
        rdBefore: player.before.rd,
        rdAfter: player.after.rd,
      })),
    });

    return {
      match: { ...confirmed, status: STATUS.CONFIRMED, confirmedAt: now },
      applied: true,
    };
  });
}
