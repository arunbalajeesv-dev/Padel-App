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

async function get(path, { token = 'good' } = {}) {
  const server = await sharedServer();
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * @param {object} over rating/status/gender/area overrides.
 */
const player = (id, { rating = 1500, status = 'established', gender = 'M', area = 'OMR' } = {}) => ({
  name: id,
  gender,
  area,
  rating: { value: rating, rd: 80, sigma: 0.06 },
  status,
  gamesPlayed: 20,
  isAdmin: false,
  phone: '+911234567890',
});

function seed(players) {
  const docs = { 'config/rating': CONFIG };

  // requireAuth loads the caller's own profile, so they must exist. Kept in
  // placement so they never appear on the board they are asking for — every
  // expectation below is about the seeded players alone.
  docs['users/caller'] = player('caller', { status: 'placement' });

  for (const [id, opts] of Object.entries(players)) docs[`users/${id}`] = player(id, opts);
  return docs;
}

const names = (body) => body.entries.map((e) => e.name);

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  verifyIdToken.mockResolvedValue({ uid: 'caller' });
  db = makeFirestore(seed({ caller: { rating: 1500 } }));
});

describe('GET /leaderboard — placement players are never shown', () => {
  it('excludes a placement player who would otherwise top the board', async () => {
    // The single most important rule on this endpoint. A placement player with
    // the highest rating in the club must still not appear.
    db = makeFirestore(
      seed({
        newcomer: { rating: 2400, status: 'placement' },
        settled: { rating: 1600, status: 'established' },
        halfway: { rating: 1550, status: 'provisional' },
      }),
    );

    const { status, body } = await get('/leaderboard?pool=open');

    expect(status).toBe(200);
    expect(names(body)).toEqual(['settled', 'halfway']);
    expect(names(body)).not.toContain('newcomer');
  });

  it('shows provisional and established players', async () => {
    db = makeFirestore(
      seed({
        p: { rating: 1700, status: 'provisional' },
        e: { rating: 1600, status: 'established' },
      }),
    );

    expect(names((await get('/leaderboard?pool=open')).body)).toEqual(['p', 'e']);
  });

  it('returns an empty board when everyone is in placement', async () => {
    db = makeFirestore(
      seed({ a: { status: 'placement' }, b: { status: 'placement' } }),
    );

    const { status, body } = await get('/leaderboard?pool=open');

    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
  });
});

describe('GET /leaderboard — sorted by stored rating, not the display value', () => {
  it('orders correctly above the display clamp, where display ties', async () => {
    // Both are past displayScale.ratingAtMax (2500), so both render as 7.0.
    // Sorting by the display value would tie them and order them arbitrarily —
    // at the very top of the ladder, where the community knows the true order.
    db = makeFirestore(
      seed({
        best: { rating: 2800 },
        second: { rating: 2600 },
        third: { rating: 2000 },
      }),
    );

    const { body } = await get('/leaderboard?pool=open');

    expect(names(body)).toEqual(['best', 'second', 'third']);

    // Confirms the premise: the top two are genuinely indistinguishable on
    // display, so the order can only have come from the stored rating.
    expect(body.entries[0].ratingDisplay).toBe(CONFIG.displayScale.maxUnits);
    expect(body.entries[1].ratingDisplay).toBe(CONFIG.displayScale.maxUnits);
  });

  it('ranks from 1 in descending rating order', async () => {
    db = makeFirestore(
      seed({ low: { rating: 1400 }, high: { rating: 1900 }, mid: { rating: 1600 } }),
    );

    const { body } = await get('/leaderboard?pool=open');

    expect(names(body)).toEqual(['high', 'mid', 'low']);
    expect(body.entries.map((e) => e.rank)).toEqual([1, 2, 3]);
  });
});

describe('GET /leaderboard — pools', () => {
  beforeEach(() => {
    db = makeFirestore(
      seed({
        m1: { gender: 'M', rating: 1800 },
        f1: { gender: 'F', rating: 1900 },
        m2: { gender: 'M', rating: 1700 },
        f2: { gender: 'F', rating: 1600 },
      }),
    );
  });

  it("men's filters by gender", async () => {
    expect(names((await get('/leaderboard?pool=men')).body)).toEqual(['m1', 'm2']);
  });

  it("women's filters by gender", async () => {
    expect(names((await get('/leaderboard?pool=women')).body)).toEqual(['f1', 'f2']);
  });

  it('open is every player, unfiltered', async () => {
    expect(names((await get('/leaderboard?pool=open')).body)).toEqual(['f1', 'm1', 'm2', 'f2']);
  });

  it('defaults to open', async () => {
    expect(names((await get('/leaderboard')).body)).toEqual(['f1', 'm1', 'm2', 'f2']);
  });

  it('400s an unknown pool, including the deleted mixed pool', async () => {
    // matchPool was deleted and a mixed tab cannot be built correctly: one
    // latent rating per player means no mixed-specific rating exists to rank.
    const { status, body } = await get('/leaderboard?pool=mixed');

    expect(status).toBe(400);
    expect(body.errors[0]).toMatch(/pool must be one of: men, women, open/);
  });
});

describe('GET /leaderboard — area filter', () => {
  it('filters by area', async () => {
    db = makeFirestore(
      seed({
        omr1: { area: 'OMR', rating: 1800 },
        ecr1: { area: 'ECR', rating: 1900 },
        omr2: { area: 'OMR', rating: 1600 },
      }),
    );

    expect(names((await get('/leaderboard?area=OMR')).body)).toEqual(['omr1', 'omr2']);
  });

  it('combines area with a pool', async () => {
    db = makeFirestore(
      seed({
        a: { area: 'OMR', gender: 'M', rating: 1800 },
        b: { area: 'OMR', gender: 'F', rating: 1900 },
        c: { area: 'ECR', gender: 'M', rating: 1700 },
      }),
    );

    expect(names((await get('/leaderboard?pool=men&area=OMR')).body)).toEqual(['a']);
  });
});

describe('GET /leaderboard — movement indicator', () => {
  const historyEntry = (before, after, daysAgo) => ({
    matchId: `m-${daysAgo}`,
    ratingBefore: before,
    ratingAfter: after,
    rdBefore: 90,
    rdAfter: 80,
    configVersion: 1,
    createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  });

  it('reports up, down and flat against the period', async () => {
    db = makeFirestore({
      ...seed({ riser: { rating: 1700 }, faller: { rating: 1400 }, idle: { rating: 1500 } }),
      // Rose from 1500 to 1700 inside the window.
      'users/riser/ratingHistory/h1': historyEntry(1500, 1600, 3),
      // Fell from 1600 to 1400 inside the window.
      'users/faller/ratingHistory/h1': historyEntry(1600, 1500, 3),
    });

    const { body } = await get('/leaderboard?pool=open&period=30d');
    const movement = Object.fromEntries(body.entries.map((e) => [e.name, e.movement]));

    expect(movement.riser).toBe('up');
    expect(movement.faller).toBe('down');
    // No history in the window means the rating has not moved. That is a fact,
    // not an estimate.
    expect(movement.idle).toBe('flat');
  });

  it('ignores history outside the period', async () => {
    db = makeFirestore({
      ...seed({ riser: { rating: 1700 } }),
      'users/riser/ratingHistory/h1': historyEntry(1500, 1600, 40),
    });

    expect((await get('/leaderboard?pool=open&period=30d')).body.entries[0].movement).toBe('flat');
    // The same player over a window that contains the match.
    expect((await get('/leaderboard?pool=open&period=all')).body.entries[0].movement).toBe('up');
  });

  it('does not let the period change who appears or how they rank', async () => {
    db = makeFirestore(seed({ high: { rating: 1900 }, low: { rating: 1500 } }));

    for (const period of ['7d', '30d', 'all']) {
      expect(names((await get(`/leaderboard?period=${period}`)).body)).toEqual(['high', 'low']);
    }
  });

  it('400s an unknown period', async () => {
    const { status, body } = await get('/leaderboard?period=90d');

    expect(status).toBe(400);
    expect(body.errors[0]).toMatch(/period must be one of/);
  });
});

describe('GET /leaderboard — exposure', () => {
  it('never returns internal rating state', async () => {
    db = makeFirestore(seed({ someone: { rating: 1800 } }));

    const { body } = await get('/leaderboard?pool=open');
    const raw = JSON.stringify(body);

    expect(raw).not.toMatch(/"value"|"rd"|"sigma"|"trustScore"|"phone"|"gamesPlayed"|"status"/);
    expect(body.entries[0]).toEqual({
      rank: 1,
      id: 'someone',
      name: 'someone',
      photoUrl: null,
      area: 'OMR',
      ratingDisplay: expect.any(Number),
      movement: 'flat',
    });
  });

  it('401s without a token', async () => {
    expect((await get('/leaderboard', { token: null })).status).toBe(401);
  });
});
