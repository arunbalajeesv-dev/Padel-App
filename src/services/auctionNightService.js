import { getFirestore } from '../config/firebase.js';

/**
 * Standalone draft-auction tool for community game nights (padel, or anything
 * else run as a captains' auction). Deliberately isolated from the rating
 * app's own domain: its own Firestore collection, no player/user/match data
 * touched, no auth — see auction-night/README for the trust model (open by
 * link, same as texting a link to the group chat).
 */

const COLLECTION = 'auctionEvents';
const PALETTE = ['#F5A524', '#3BC9DB', '#FF7A7A', '#5BE49B', '#AEA1FF', '#FFB4D6', '#8ED1FC', '#D6A756'];
const DEFAULT_STEPS = [100, 250, 500, 1000, 2500];
const DEFAULT_FLOOR_PRICE = 100;
const MIN_TEAMS = 2;
const MAX_TEAMS = 8;

// Anti-sniping: a bid landing inside the last TIMER_EXTEND_WINDOW_SECONDS of
// the countdown pushes the deadline out by TIMER_EXTEND_SECONDS. Fixed rather
// than per-auction config for now — see auction-night's timer design notes.
export const TIMER_EXTEND_SECONDS = 15;
export const TIMER_EXTEND_WINDOW_SECONDS = 10;

const ALLOWED_CREATE_FIELDS = ['title', 'teams', 'purse', 'slots', 'timerSeconds'];

// Fields the live bidding/sync endpoint (open, unauthenticated) may touch.
// Everything else — pins, teams, settings, title — is admin-only and must
// never be reachable through the state-sync write, or the PIN gate below is
// worthless: anyone who knows an auction's id could just POST new pins.
const PUBLIC_STATE_FIELDS = ['players', 'currentId', 'bid', 'bidder', 'step', 'lotEndsAt', 'history', 'purse', 'seats', 'seq'];

const PIN_ROLES = ['captain', 'mod', 'viewer'];

function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

/** Three distinct 4-digit PINs, one per role — collisions would let one PIN answer for two roles. */
function generatePins() {
  const pins = {};
  const used = new Set();
  for (const role of PIN_ROLES) {
    let pin;
    do { pin = generatePin(); } while (used.has(pin));
    used.add(pin);
    pins[role] = pin;
  }
  return pins;
}

/** Strips the auction's secrets before it goes anywhere public. */
function redact(doc) {
  const { pins, ...rest } = doc;
  return rest;
}

export function validateCreate(body) {
  const input = body && typeof body === 'object' ? body : {};
  const rejected = Object.keys(input).filter((k) => !ALLOWED_CREATE_FIELDS.includes(k));
  const errors = [];

  const title = String(input.title ?? '').trim().slice(0, 80) || 'Untitled auction';

  const teamNames = Array.isArray(input.teams)
    ? input.teams.map((t) => String(t ?? '').trim().slice(0, 24)).filter(Boolean)
    : [];
  if (teamNames.length < MIN_TEAMS) errors.push(`At least ${MIN_TEAMS} team names are required.`);
  if (teamNames.length > MAX_TEAMS) errors.push(`At most ${MAX_TEAMS} teams are supported.`);

  const purse = Number(input.purse);
  if (!Number.isInteger(purse) || purse < 100 || purse > 1000000) {
    errors.push('purse must be an integer between 100 and 1,000,000.');
  }

  const slots = Number(input.slots);
  if (!Number.isInteger(slots) || slots < 1 || slots > 10) {
    errors.push('slots must be an integer between 1 and 10.');
  }

  // 0 (or omitted) means "no timer" — an opt-in feature, not a default.
  const timerSeconds = input.timerSeconds === undefined || input.timerSeconds === null || input.timerSeconds === 0
    ? 0
    : Number(input.timerSeconds);
  if (timerSeconds !== 0 && (!Number.isInteger(timerSeconds) || timerSeconds < 10 || timerSeconds > 600)) {
    errors.push('timerSeconds must be 0 (no timer) or an integer between 10 and 600.');
  }

  return { rejected, errors, value: { title, teamNames, purse, slots, timerSeconds } };
}

function computeStatus(doc) {
  const counts = {};
  for (const p of doc.players) {
    if (p.status === 'sold') counts[p.team] = (counts[p.team] || 0) + 1;
  }
  const complete = doc.teams.every((t) => (counts[t.key] || 0) >= doc.settings.slots);
  return complete ? 'complete' : 'live';
}

export async function createAuction({ title, teamNames, purse, slots, timerSeconds }) {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc();

  const teams = teamNames.map((name, i) => ({ key: `t${i + 1}`, name, color: PALETTE[i % PALETTE.length] }));

  const doc = {
    id: ref.id,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rev: 1,
    status: 'live',
    settings: { purse, slots, floorPrice: DEFAULT_FLOOR_PRICE, steps: DEFAULT_STEPS, timerSeconds },
    teams,
    pins: generatePins(),
    seq: 1,
    players: [],
    currentId: null,
    bid: 0,
    bidder: null,
    step: DEFAULT_STEPS[2],
    lotEndsAt: null,
    history: [],
    purse: Object.fromEntries(teams.map((t) => [t.key, purse])),
    seats: Object.fromEntries([...teams.map((t) => [t.key, null]), ['mod', null]]),
  };

  await ref.set(doc);
  return doc;
}

export async function listAuctions() {
  const db = getFirestore();
  const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(100).get();
  return snap.docs.map((d) => {
    const a = d.data();
    return {
      id: a.id,
      title: a.title,
      teams: a.teams.map((t) => ({ name: t.name, color: t.color })),
      status: a.status,
      createdAt: a.createdAt,
    };
  });
}

/** Admin-only: same list, but with each auction's PINs so they can be re-shared later. */
export async function listAuctionsForAdmin() {
  const db = getFirestore();
  const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(100).get();
  return snap.docs.map((d) => {
    const a = d.data();
    return {
      id: a.id,
      title: a.title,
      teams: a.teams.map((t) => ({ name: t.name, color: t.color })),
      status: a.status,
      createdAt: a.createdAt,
      pins: a.pins,
    };
  });
}

export async function getAuction(id) {
  const db = getFirestore();
  const snap = await db.collection(COLLECTION).doc(id).get();
  return snap.exists ? redact(snap.data()) : null;
}

/** Checks a PIN against an auction's three role PINs. Returns the matching role, or null. */
export async function verifyPin(id, pin) {
  const db = getFirestore();
  const snap = await db.collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  const { pins } = snap.data();
  const candidate = String(pin ?? '').trim();
  const role = PIN_ROLES.find((r) => pins?.[r] === candidate);
  return role ?? null;
}

/**
 * Optimistic-concurrency write: the caller must supply the rev it last read.
 * Two devices racing to write the same rev is the expected case (a double
 * bid tap, two captains acting at once), not a corner case, so this is a
 * real Firestore transaction rather than a read-then-write that could race.
 *
 * `state` comes from an unauthenticated caller, so it is filtered down to
 * PUBLIC_STATE_FIELDS before being applied — see the constant above.
 */
export async function writeAuctionState(id, expectedRev, state) {
  const db = getFirestore();
  const ref = db.collection(COLLECTION).doc(id);

  const publicState = Object.fromEntries(
    Object.entries(state).filter(([key]) => PUBLIC_STATE_FIELDS.includes(key)),
  );

  const outcome = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return { notFound: true };
    const current = snap.data();
    if (current.rev !== expectedRev) return { conflict: true, auction: redact(current) };

    const next = {
      ...current,
      ...publicState,
      id: current.id,
      createdAt: current.createdAt,
      pins: current.pins,
      rev: current.rev + 1,
      updatedAt: Date.now(),
    };
    next.status = computeStatus(next);
    t.set(ref, next);
    return { auction: redact(next) };
  });

  return outcome;
}
