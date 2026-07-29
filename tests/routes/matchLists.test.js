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
let _server;
async function sharedServer() {
  if (!_server) _server = await listen(createApp());
  return _server;
}
afterAll(() => {
  _server?.closeAllConnections?.();
  _server?.close();
});

async function get(path, { token = 'me' } = {}) {
  const server = await sharedServer();
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const user = (id, name) => ({
  name,
  gender: 'M',
  rating: { value: 1500, rd: 200, sigma: 0.06 },
  status: 'placement',
  gamesPlayed: 0,
});

const court = (id, name) => ({ name, area: 'OMR' });

/** A match doc. `confirmedBy` and `status` drive which list it lands in. */
const match = (id, over = {}) => ({
  courtId: 'court-1',
  teamA: ['me', 'a2'],
  teamB: ['b1', 'b2'],
  players: ['me', 'a2', 'b1', 'b2'],
  sets: [{ teamA: 6, teamB: 2 }, { teamA: 6, teamB: 3 }],
  gamesA: 12,
  gamesB: 5,
  winner: 'A',
  format: 'threeSet',
  playedAt: '2026-07-15T10:00:00.000Z',
  status: 'pending',
  reportedBy: 'b1',
  confirmedBy: ['b1'],
  createdAt: '2026-07-15T12:00:00.000Z',
  ...over,
});

function seed(matches = {}) {
  const docs = {
    'config/rating': CONFIG,
    'users/me': user('me', 'Arjun'),
    'users/a2': user('a2', 'Karthik'),
    'users/b1': user('b1', 'Vikram'),
    'users/b2': user('b2', 'Ravi'),
    'courts/court-1': court('court-1', 'OMR Arena'),
  };
  for (const [id, m] of Object.entries(matches)) docs[`matches/${id}`] = match(id, m);
  return docs;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  verifyIdToken.mockResolvedValue({ uid: 'me' });
  db = makeFirestore(seed());
});

describe('GET /matches/pending', () => {
  it('tags a match the viewer still owes as action-needed', async () => {
    // b1 reported, me has not confirmed → me needs to act.
    db = makeFirestore(seed({ m1: { reportedBy: 'b1', confirmedBy: ['b1'] } }));

    const { status, body } = await get('/matches/pending');

    expect(status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].id).toBe('m1');
    expect(body.matches[0].status).toBe('pending');
    expect(body.matches[0].viewerNeedsToConfirm).toBe(true);
    // Names + court resolved server-side, so the client renders words not uids.
    expect(body.players.me).toBe('Arjun');
    expect(body.players.b1).toBe('Vikram');
    expect(body.courts['court-1']).toBe('OMR Arena');
  });

  it('STILL shows a match the viewer already confirmed, tagged waiting (no action)', async () => {
    // The reporter's own logged match: they confirmed at creation, but it is
    // still pending on the other team. It must appear on their Home — just
    // without a Confirm button.
    db = makeFirestore(seed({ m1: { reportedBy: 'me', confirmedBy: ['me'] } }));

    const { body } = await get('/matches/pending');

    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].viewerNeedsToConfirm).toBe(false);
  });

  it('excludes confirmed (already rated) matches', async () => {
    db = makeFirestore(seed({ m1: { status: 'confirmed', confirmedBy: ['b1'] } }));
    expect((await get('/matches/pending')).body.matches).toEqual([]);
  });

  it('excludes matches the caller did not play in', async () => {
    db = makeFirestore(
      seed({ m1: { teamA: ['x1', 'x2'], teamB: ['y1', 'y2'], players: ['x1', 'x2', 'y1', 'y2'], confirmedBy: ['x1'] } }),
    );
    expect((await get('/matches/pending')).body.matches).toEqual([]);
  });

  it('is empty (not an error) when there is nothing pending', async () => {
    const { status, body } = await get('/matches/pending');
    expect(status).toBe(200);
    expect(body.matches).toEqual([]);
  });

  it('401s without a token', async () => {
    expect((await get('/matches/pending', { token: null })).status).toBe(401);
  });

  it('includes a disputed match, so it never simply disappears while awaiting an admin', async () => {
    db = makeFirestore(seed({ m1: { status: 'disputed', confirmedBy: ['b1'] } }));

    const { status, body } = await get('/matches/pending');

    expect(status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].status).toBe('disputed');
  });

  it('excludes a rejected match — that outcome lives in recent activity, not here', async () => {
    db = makeFirestore(seed({ m1: { status: 'rejected', confirmedBy: ['b1'] } }));
    expect((await get('/matches/pending')).body.matches).toEqual([]);
  });
});

describe('GET /matches/:id', () => {
  it('returns the full match to a participant, tagged with their state', async () => {
    db = makeFirestore(seed({ m1: { reportedBy: 'b1', confirmedBy: ['b1'] } }));

    const { status, body } = await get('/matches/m1');

    expect(status).toBe(200);
    expect(body.match.id).toBe('m1');
    expect(body.match.viewerNeedsToConfirm).toBe(true);
    expect(body.players.b1).toBe('Vikram');
    expect(body.courts['court-1']).toBe('OMR Arena');
  });

  it('reports the viewer state for someone who already confirmed', async () => {
    db = makeFirestore(seed({ m1: { reportedBy: 'me', confirmedBy: ['me'] } }));
    expect((await get('/matches/m1')).body.match.viewerNeedsToConfirm).toBe(false);
  });

  it('403s a non-participant — a match record is not public', async () => {
    db = makeFirestore(
      seed({ m1: { teamA: ['x1', 'x2'], teamB: ['y1', 'y2'], players: ['x1', 'x2', 'y1', 'y2'] } }),
    );
    expect((await get('/matches/m1')).status).toBe(403);
  });

  it('404s an unknown match', async () => {
    expect((await get('/matches/nope')).status).toBe(404);
  });

  it('does not capture the literal /pending path as an id', async () => {
    // /matches/pending must route to the list, not GET /matches/:id with id="pending".
    db = makeFirestore(seed({ m1: {} }));
    const { status, body } = await get('/matches/pending');
    expect(status).toBe(200);
    expect(Array.isArray(body.matches)).toBe(true);
  });

  it('401s without a token', async () => {
    expect((await get('/matches/m1', { token: null })).status).toBe(401);
  });
});

describe('GET /matches/recent', () => {
  it('returns only confirmed matches, newest first', async () => {
    db = makeFirestore(
      seed({
        old: { status: 'confirmed', playedAt: '2026-07-01T10:00:00.000Z' },
        recent: { status: 'confirmed', playedAt: '2026-07-20T10:00:00.000Z' },
        mid: { status: 'confirmed', playedAt: '2026-07-10T10:00:00.000Z' },
        stillPending: { status: 'pending' },
      }),
    );

    const { body } = await get('/matches/recent');

    expect(body.matches.map((m) => m.id)).toEqual(['recent', 'mid', 'old']);
    expect(body.matches.every((m) => m.status === 'confirmed')).toBe(true);
  });

  it('honours a limit', async () => {
    db = makeFirestore(
      seed({
        a: { status: 'confirmed', playedAt: '2026-07-20T00:00:00.000Z' },
        b: { status: 'confirmed', playedAt: '2026-07-19T00:00:00.000Z' },
        c: { status: 'confirmed', playedAt: '2026-07-18T00:00:00.000Z' },
      }),
    );

    const { body } = await get('/matches/recent?limit=2');
    expect(body.matches.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('never exposes rating internals in a match view', async () => {
    db = makeFirestore(seed({ m1: { status: 'confirmed' } }));
    const raw = JSON.stringify((await get('/matches/recent')).body);
    expect(raw).not.toMatch(/ratingDeltas|"value"|"rd"|"sigma"|multipliers/);
  });

  it('is empty when the player has no rated matches', async () => {
    expect((await get('/matches/recent')).body.matches).toEqual([]);
  });

  it('includes a rejected match — a cancelled dispute is a visible outcome, not a silent vanish', async () => {
    db = makeFirestore(
      seed({
        rated: { status: 'confirmed', playedAt: '2026-07-20T10:00:00.000Z' },
        cancelled: { status: 'rejected', playedAt: '2026-07-19T10:00:00.000Z' },
        stillDisputed: { status: 'disputed', playedAt: '2026-07-18T10:00:00.000Z' },
      }),
    );

    const { body } = await get('/matches/recent');

    expect(body.matches.map((m) => m.id)).toEqual(['rated', 'cancelled']);
    expect(body.matches.find((m) => m.id === 'cancelled').status).toBe('rejected');
  });
});

describe('GET /users/:id/matches — another player\'s match history', () => {
  it('returns confirmed matches for the TARGET player, regardless of who is asking', async () => {
    // "me" is the caller (per verifyIdToken), but b1 is whose history we want.
    db = makeFirestore(
      seed({
        m1: { teamA: ['b1', 'x2'], teamB: ['y1', 'y2'], players: ['b1', 'x2', 'y1', 'y2'], status: 'confirmed' },
      }),
    );

    const { status, body } = await get('/users/b1/matches');

    expect(status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].id).toBe('m1');
  });

  it('excludes matches the target player was not part of', async () => {
    // The default match is me/a2 vs b1/b2 — b2's own confirmed match, but not
    // one a2 played in.
    db = makeFirestore(seed({ m1: { status: 'confirmed' } }));
    expect((await get('/users/a2/matches')).body.matches).toHaveLength(1);

    db = makeFirestore(
      seed({
        m1: { teamA: ['me', 'x9'], teamB: ['b1', 'b2'], players: ['me', 'x9', 'b1', 'b2'], status: 'confirmed' },
      }),
    );
    expect((await get('/users/a2/matches')).body.matches).toEqual([]);
  });

  it('excludes still-pending matches, same as /matches/recent', async () => {
    db = makeFirestore(seed({ m1: { status: 'pending' } }));
    expect((await get('/users/me/matches')).body.matches).toEqual([]);
  });

  it('honours a limit', async () => {
    db = makeFirestore(
      seed({
        a: { status: 'confirmed', playedAt: '2026-07-20T00:00:00.000Z' },
        b: { status: 'confirmed', playedAt: '2026-07-19T00:00:00.000Z' },
        c: { status: 'confirmed', playedAt: '2026-07-18T00:00:00.000Z' },
      }),
    );

    const { body } = await get('/users/me/matches?limit=2');
    expect(body.matches.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('never exposes rating internals', async () => {
    db = makeFirestore(seed({ m1: { status: 'confirmed' } }));
    const raw = JSON.stringify((await get('/users/me/matches')).body);
    expect(raw).not.toMatch(/ratingDeltas|"value"|"rd"|"sigma"|multipliers/);
  });

  it('404s an unknown player', async () => {
    expect((await get('/users/ghost/matches')).status).toBe(404);
  });

  it('401s without a token', async () => {
    expect((await get('/users/me/matches', { token: null })).status).toBe(401);
  });
});
