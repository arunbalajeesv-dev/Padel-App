import { describe, it, expect, vi, beforeEach } from 'vitest';

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

async function post(path, { token = 'good', body } = {}) {
  const server = await listen(createApp());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const PLAYERS = ['me', 'a2', 'b1', 'b2'];

const user = (id) => ({
  name: id,
  gender: 'M',
  rating: { value: 1500, rd: 300, sigma: 0.06 },
  status: 'provisional',
  gamesPlayed: 10,
  trustScore: 0,
  isAdmin: false,
});

const MATCH = {
  courtId: 'court-1',
  teamA: ['me', 'a2'],
  teamB: ['b1', 'b2'],
  players: PLAYERS,
  status: 'confirmed',
  playedAt: '2026-07-17T10:00:00.000Z',
};

/** Ratings for the caller 'me' covering the other three. */
const GOOD_RATINGS = { a2: 5, b1: 4, b2: 3 };

function seed() {
  const docs = { 'config/rating': CONFIG, 'matches/m1': MATCH };
  for (const id of PLAYERS) docs[`users/${id}`] = user(id);
  return docs;
}

const feedbackDocs = () =>
  [...db.state.entries()].filter(([p]) => p.startsWith('feedback/')).map(([, d]) => d);
const trustLogs = () =>
  [...db.state.entries()].filter(([p]) => p.startsWith('trustLogs/')).map(([, d]) => d);

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  verifyIdToken.mockResolvedValue({ uid: 'me' });
  db = makeFirestore(seed());
});

describe('POST /feedback — happy path', () => {
  it('writes a feedback document for the caller', async () => {
    const { status, body } = await post('/feedback', {
      body: { matchId: 'm1', ratings: GOOD_RATINGS },
    });

    expect(status).toBe(201);
    expect(body.matchId).toBe('m1');
    expect(body.fromUid).toBe('me');

    expect(feedbackDocs()).toHaveLength(1);
    expect(feedbackDocs()[0].ratings).toEqual(GOOD_RATINGS);
  });

  it('appends one trustLog per rated player', async () => {
    await post('/feedback', { body: { matchId: 'm1', ratings: GOOD_RATINGS } });

    const logs = trustLogs();
    expect(logs).toHaveLength(3);

    const bySubject = Object.fromEntries(logs.map((l) => [l.subjectUid, l]));
    expect(bySubject.a2.score).toBe(5);
    expect(bySubject.b1.score).toBe(4);
    expect(bySubject.b2.score).toBe(3);
    for (const log of logs) expect(log.fromUid).toBe('me');
  });

  it('NEVER touches any skill rating', async () => {
    // The core guarantee. Feedback feeds trust only — the ladder is not a
    // popularity contest. See feedbackService.js header.
    const before = PLAYERS.map((id) => ({ ...db.state.get(`users/${id}`).rating }));

    await post('/feedback', { body: { matchId: 'm1', ratings: GOOD_RATINGS } });

    PLAYERS.forEach((id, i) => {
      expect(db.state.get(`users/${id}`).rating).toEqual(before[i]);
      // Not even trustScore is written: the aggregate is deferred, only the raw
      // log is stored.
      expect(db.state.get(`users/${id}`).trustScore).toBe(0);
    });

    // No ratingHistory entry was created by feedback.
    const history = [...db.state.keys()].filter((p) => p.includes('/ratingHistory/'));
    expect(history).toEqual([]);
  });
});

describe('POST /feedback — participation and coverage', () => {
  it('403s when the caller did not play in the match', async () => {
    db = makeFirestore({ ...seed(), 'users/outsider': user('outsider') });
    verifyIdToken.mockResolvedValue({ uid: 'outsider' });

    const { status } = await post('/feedback', {
      body: { matchId: 'm1', ratings: GOOD_RATINGS },
    });

    expect(status).toBe(403);
    expect(feedbackDocs()).toEqual([]);
  });

  it('404s an unknown match', async () => {
    const { status } = await post('/feedback', {
      body: { matchId: 'nope', ratings: GOOD_RATINGS },
    });
    expect(status).toBe(404);
  });

  it('400s when a rating for a teammate/opponent is missing', async () => {
    const { status, body } = await post('/feedback', {
      body: { matchId: 'm1', ratings: { a2: 5, b1: 4 } },
    });

    expect(status).toBe(400);
    expect(body.reason).toMatch(/missing: b2/);
  });

  it('400s when rating a player who was not on the court', async () => {
    const { status, body } = await post('/feedback', {
      body: { matchId: 'm1', ratings: { a2: 5, b1: 4, stranger: 3 } },
    });

    expect(status).toBe(400);
    expect(body.reason).toMatch(/not your opponents: stranger/);
  });

  it('400s when rating oneself', async () => {
    const { status, body } = await post('/feedback', {
      body: { matchId: 'm1', ratings: { me: 5, a2: 4, b1: 3 } },
    });

    expect(status).toBe(400);
    // 'me' is unexpected (you don't rate yourself) and b2 is missing.
    expect(body.reason).toMatch(/not your opponents: me/);
  });
});

describe('POST /feedback — one submission per player per match', () => {
  it('409s a second submission from the same player', async () => {
    await post('/feedback', { body: { matchId: 'm1', ratings: GOOD_RATINGS } });

    const { status, body } = await post('/feedback', {
      body: { matchId: 'm1', ratings: GOOD_RATINGS },
    });

    expect(status).toBe(409);
    expect(body.reason).toMatch(/already rated/);
    expect(feedbackDocs()).toHaveLength(1);
    expect(trustLogs()).toHaveLength(3);
  });

  it('lets a different player in the same match submit their own feedback', async () => {
    await post('/feedback', { body: { matchId: 'm1', ratings: GOOD_RATINGS } });

    verifyIdToken.mockResolvedValue({ uid: 'b1' });
    const { status } = await post('/feedback', {
      body: { matchId: 'm1', ratings: { me: 5, a2: 5, b2: 4 } },
    });

    expect(status).toBe(201);
    expect(feedbackDocs()).toHaveLength(2);
    expect(trustLogs()).toHaveLength(6);
  });
});

describe('POST /feedback — score validation', () => {
  it.each([
    ['a score above the scale', { a2: 6, b1: 4, b2: 3 }],
    ['a score below the scale', { a2: 0, b1: 4, b2: 3 }],
    ['a fractional score', { a2: 4.5, b1: 4, b2: 3 }],
    ['a non-number score', { a2: 'great', b1: 4, b2: 3 }],
  ])('400s on %s', async (_label, ratings) => {
    const { status } = await post('/feedback', { body: { matchId: 'm1', ratings } });

    expect(status).toBe(400);
    expect(feedbackDocs()).toEqual([]);
    expect(trustLogs()).toEqual([]);
  });

  it('400s on an unknown top-level field', async () => {
    const { status, body } = await post('/feedback', {
      body: { matchId: 'm1', ratings: GOOD_RATINGS, skillRating: 7 },
    });

    expect(status).toBe(400);
    expect(body.rejected).toEqual(['skillRating']);
  });

  it('401s without a token', async () => {
    expect(
      (await post('/feedback', { token: null, body: { matchId: 'm1', ratings: GOOD_RATINGS } })).status,
    ).toBe(401);
  });
});
