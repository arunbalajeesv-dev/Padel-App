import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import { VALID_CONFIG as CONFIG } from '../fixtures/config.js';
import { makeFirestore } from '../fixtures/fakeFirestore.js';

const verifyIdToken = vi.fn();

let db;

vi.mock('../../src/config/firebase.js', () => ({
  getAuth: () => ({ verifyIdToken }),
  getFirestore: () => db,
}));

const { createApp } = await import('../../src/app.js');
const { invalidateConfigCache } = await import('../../src/services/configService.js');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// ONE server per file, reused across tests. Spinning a server up and down per
// request churns ephemeral ports fast enough that a recycled port can serve the
// next request from a different listener — an observed ~1-in-25 flake.
let _server;
async function sharedServer() {
  if (!_server) _server = await listen(createApp());
  return _server;
}
afterAll(() => {
  _server?.closeAllConnections?.();
  _server?.close();
});

async function post(path, { token = 'good', body } = {}) {
  const server = await sharedServer();
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const PLAYERS = ['me', 'a2', 'b1', 'b2'];

const user = (id) => ({
  name: id,
  gender: 'M',
  rating: { value: 1500, rd: 350, sigma: 0.06 },
  status: 'placement',
  gamesPlayed: 0,
  isAdmin: false,
});

const match = (over = {}) => ({
  courtId: 'court-1',
  teamA: ['me', 'a2'],
  teamB: ['b1', 'b2'],
  players: PLAYERS,
  sets: [{ teamA: 6, teamB: 4 }, { teamA: 6, teamB: 3 }],
  format: 'threeSet',
  winner: 'A',
  gamesA: 12,
  gamesB: 7,
  playedAt: '2026-07-17T10:00:00.000Z',
  status: 'pending',
  reportedBy: 'me',
  confirmedBy: ['me'],
  ...over,
});

const REASON = 'The score is wrong, we lost the second set 6-4 not won it.';

function seed(matchOver = {}) {
  const docs = { 'config/rating': CONFIG, 'matches/m1': match(matchOver) };
  for (const id of PLAYERS) docs[`users/${id}`] = user(id);
  return docs;
}

const matchDoc = () => db.state.get('matches/m1');
const disputeDocs = () =>
  [...db.state.entries()].filter(([p]) => p.startsWith('disputes/')).map(([, d]) => d);

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  verifyIdToken.mockResolvedValue({ uid: 'me' });
  db = makeFirestore(seed());
});

describe('POST /matches/:id/dispute — a pending match is blocked', () => {
  it('sets the match to disputed and creates a dispute document', async () => {
    const { status, body } = await post('/matches/m1/dispute', {
      body: { reason: REASON, evidenceUrl: 'https://example.com/photo.jpg' },
    });

    expect(status).toBe(201);
    expect(body.status).toBe('open');

    expect(matchDoc().status).toBe('disputed');

    const [dispute] = disputeDocs();
    expect(dispute.matchId).toBe('m1');
    expect(dispute.raisedBy).toBe('me');
    expect(dispute.reason).toBe(REASON);
    expect(dispute.evidenceUrl).toBe('https://example.com/photo.jpg');
  });

  it('makes the match unratable — confirmation is refused afterwards', async () => {
    // The guarantee that matters: a disputed match must never affect ratings.
    await post('/matches/m1/dispute', { body: { reason: REASON } });

    // b1 tries to complete the both-teams confirmation on the disputed match.
    verifyIdToken.mockResolvedValue({ uid: 'b1' });
    const confirm = await post('/matches/m1/confirm');

    expect(confirm.status).toBe(409);
    expect(matchDoc().status).toBe('disputed');
    for (const id of PLAYERS) {
      expect(db.state.get(`users/${id}`).rating.value).toBe(1500);
    }
  });

  it('stores evidenceUrl as null when omitted', async () => {
    await post('/matches/m1/dispute', { body: { reason: REASON } });
    expect(disputeDocs()[0].evidenceUrl).toBeNull();
  });
});

describe('POST /matches/:id/dispute — a confirmed match can no longer be disputed', () => {
  beforeEach(() => {
    // A confirmed match whose ratings were already applied and RD already fell.
    db = makeFirestore({
      ...seed({ status: 'confirmed', confirmedBy: ['me', 'b1'] }),
    });
    for (const id of PLAYERS) {
      db.state.set(`users/${id}`, {
        ...user(id),
        rating: { value: 1540, rd: 300, sigma: 0.06 },
        gamesPlayed: 1,
        status: 'placement',
      });
    }
  });

  it('409s — both-team confirmation is the trust checkpoint, and it has already passed', async () => {
    const { status, body } = await post('/matches/m1/dispute', { body: { reason: REASON } });

    expect(status).toBe(409);
    expect(body.reason).toMatch(/already been confirmed/);
  });

  it('creates no dispute document and touches no rating', async () => {
    await post('/matches/m1/dispute', { body: { reason: REASON } });

    expect(disputeDocs()).toEqual([]);
    expect(matchDoc().status).toBe('confirmed');
    for (const id of PLAYERS) {
      expect(db.state.get(`users/${id}`).rating.value).toBe(1540);
      expect(db.state.get(`users/${id}`).rating.rd).toBe(300);
    }
  });
});

describe('POST /matches/:id/dispute — status is the single source of truth for "already disputed"', () => {
  it('409s a second dispute while one is already open, via the SAME status check — no separate query needed', async () => {
    // A match's status and "has a live dispute" are always in sync: opening one
    // sets status to disputed in the same transaction. So the second attempt is
    // rejected by the status guard, not a redundant existing-dispute lookup.
    await post('/matches/m1/dispute', { body: { reason: REASON } });

    verifyIdToken.mockResolvedValue({ uid: 'a2' });
    const { status, body } = await post('/matches/m1/dispute', { body: { reason: REASON } });

    expect(status).toBe(409);
    expect(body.reason).toMatch(/open dispute/);
    expect(disputeDocs()).toHaveLength(1);
  });

  it('409s disputing an already-rejected match', async () => {
    db = makeFirestore(seed({ status: 'rejected' }));

    const { status, body } = await post('/matches/m1/dispute', { body: { reason: REASON } });

    expect(status).toBe(409);
    expect(body.reason).toMatch(/rejected/);
  });
});

describe('POST /matches/:id/dispute — guards', () => {
  it('403s a player who was not in the match', async () => {
    db = makeFirestore({ ...seed(), 'users/outsider': user('outsider') });
    verifyIdToken.mockResolvedValue({ uid: 'outsider' });

    const { status } = await post('/matches/m1/dispute', { body: { reason: REASON } });

    expect(status).toBe(403);
    expect(matchDoc().status).toBe('pending');
    expect(disputeDocs()).toEqual([]);
  });

  it('404s an unknown match', async () => {
    expect((await post('/matches/nope/dispute', { body: { reason: REASON } })).status).toBe(404);
  });

  it.each([
    ['a missing reason', {}],
    ['too short a reason', { reason: 'nope' }],
    ['a non-http evidenceUrl', { reason: REASON, evidenceUrl: 'ftp://x/y' }],
    ['an unknown field', { reason: REASON, verdict: 'guilty' }],
  ])('400s on %s', async (_label, body) => {
    const { status } = await post('/matches/m1/dispute', { body });

    expect(status).toBe(400);
    expect(matchDoc().status).toBe('pending');
    expect(disputeDocs()).toEqual([]);
  });

  it('401s without a token', async () => {
    expect((await post('/matches/m1/dispute', { token: null, body: { reason: REASON } })).status).toBe(401);
  });
});
