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
  it('returns matches awaiting THIS player, with names resolved', async () => {
    // me reported nothing here: b1 reported, me has not confirmed → awaiting me.
    db = makeFirestore(seed({ m1: { reportedBy: 'b1', confirmedBy: ['b1'] } }));

    const { status, body } = await get('/matches/pending');

    expect(status).toBe(200);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].id).toBe('m1');
    expect(body.matches[0].status).toBe('pending');
    // Names + court resolved server-side, so the client renders words not uids.
    expect(body.players.me).toBe('Arjun');
    expect(body.players.b1).toBe('Vikram');
    expect(body.courts['court-1']).toBe('OMR Arena');
  });

  it('excludes matches the caller has already confirmed', async () => {
    db = makeFirestore(seed({ m1: { confirmedBy: ['b1', 'me'] } }));
    expect((await get('/matches/pending')).body.matches).toEqual([]);
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

  it('is empty (not an error) when there is nothing to confirm', async () => {
    const { status, body } = await get('/matches/pending');
    expect(status).toBe(200);
    expect(body.matches).toEqual([]);
  });

  it('401s without a token', async () => {
    expect((await get('/matches/pending', { token: null })).status).toBe(401);
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
});
