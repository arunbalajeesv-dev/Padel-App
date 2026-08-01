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

const user = (over = {}) => ({
  name: 'Arjun',
  gender: 'M',
  area: 'Nungambakkam',
  rating: { value: 1714.3, rd: 62, sigma: 0.0601 },
  status: 'established',
  gamesPlayed: 24,
  isAnchor: false,
  isAdmin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-07-01T00:00:00.000Z',
  ...over,
});

function seed(users = {}) {
  return {
    'config/rating': CONFIG,
    'users/me': user(),
    ...users,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  verifyIdToken.mockResolvedValue({ uid: 'me' });
  db = makeFirestore(seed());
});

describe('GET /users/:id — another player\'s profile', () => {
  it('returns the richer player view: name, gender, area, rating, status, gamesPlayed, createdAt', async () => {
    db = makeFirestore(
      seed({ 'users/b1': user({ name: 'Anita', gender: 'F' }) }),
    );

    const { status, body } = await get('/users/b1');

    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(
      ['area', 'createdAt', 'gamesPlayed', 'gender', 'id', 'name', 'photoUrl', 'ratingDisplay', 'sideStats', 'status'].sort(),
    );
    expect(body.name).toBe('Anita');
    expect(body.gender).toBe('F');
    expect(body.ratingDisplay).toBeCloseTo(3.33, 2);
    expect(body.status).toBe('established');
    expect(body.gamesPlayed).toBe(24);
  });

  it('never leaks phone, rating internals, trustScore, isAdmin or isAnchor', async () => {
    db = makeFirestore(seed({ 'users/b1': user({ phone: '+919999999999', isAdmin: true }) }));

    const { body } = await get('/users/b1');

    expect(JSON.stringify(body)).not.toMatch(
      /"phone"|"value"|"sigma"|"rd"|"trustScore"|"isAdmin"|"isAnchor"/,
    );
  });

  it('never includes a placement countdown — first-person copy that does not apply to someone else', async () => {
    db = makeFirestore(seed({ 'users/b1': user() }));
    expect((await get('/users/b1')).body.placement).toBeUndefined();
  });

  it('404s an unknown player, even though the CALLER resolves fine', async () => {
    const { status } = await get('/users/ghost');
    expect(status).toBe(404);
  });

  it('401s without a token', async () => {
    db = makeFirestore(seed({ 'users/b1': user() }));
    expect((await get('/users/b1', { token: null })).status).toBe(401);
  });

  it('does not shadow /users/me — registered first, so `:id` must not swallow "me"', async () => {
    const me = await get('/users/me');
    expect(me.status).toBe(200);
    expect(me.body.name).toBe('Arjun');
  });
});
