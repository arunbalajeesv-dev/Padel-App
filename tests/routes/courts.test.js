import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyIdToken = vi.fn();
const userGet = vi.fn();
const configGet = vi.fn();
const courtsGet = vi.fn();
const courtsAdd = vi.fn();
const whereFn = vi.fn();

import { VALID_CONFIG as CONFIG } from '../fixtures/config.js';

function courtsQuery() {
  const q = {
    where: (...args) => {
      whereFn(...args);
      return q;
    },
    orderBy: () => q,
    startAt: () => q,
    endAt: () => q,
    limit: () => q,
    get: courtsGet,
    add: courtsAdd,
    doc: () => ({ get: vi.fn() }),
  };
  return q;
}

vi.mock('../../src/config/firebase.js', () => ({
  getAuth: () => ({ verifyIdToken }),
  getFirestore: () => ({
    collection: (name) => {
      if (name === 'config') return { doc: () => ({ get: configGet }) };
      if (name === 'courts') return courtsQuery();
      return { doc: () => ({ get: userGet }) };
    },
  }),
}));

const { createApp } = await import('../../src/app.js');
const { invalidateConfigCache } = await import('../../src/services/configService.js');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function call(method, path, { token, body } = {}) {
  const server = await listen(createApp());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const asUser = (isAdmin) => ({
  exists: true,
  id: 'uid-1',
  data: () => ({
    name: 'Arun',
    gender: 'M',
    rating: { value: 1500, rd: 350, sigma: 0.06 },
    status: 'placement',
    gamesPlayed: 0,
    isAdmin,
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  configGet.mockResolvedValue({ exists: true, data: () => CONFIG });
  verifyIdToken.mockResolvedValue({ uid: 'uid-1' });
  userGet.mockResolvedValue(asUser(false));
  courtsGet.mockResolvedValue({ docs: [] });
  courtsAdd.mockResolvedValue({ id: 'court-1' });
});

describe('GET /courts', () => {
  it('lists courts for any authenticated member', async () => {
    courtsGet.mockResolvedValue({
      docs: [
        { id: 'c1', data: () => ({ name: 'Padel Park', area: 'Nungambakkam', isPartner: true, address: 'X' }) },
      ],
    });

    const { status, body } = await call('GET', '/courts', { token: 'good' });

    expect(status).toBe(200);
    expect(body.courts[0]).toEqual({
      id: 'c1',
      name: 'Padel Park',
      address: 'X',
      area: 'Nungambakkam',
      isPartner: true,
    });
  });

  it('401s without a token', async () => {
    expect((await call('GET', '/courts')).status).toBe(401);
  });

  it('filters by area', async () => {
    await call('GET', '/courts?area=Velachery', { token: 'good' });

    expect(whereFn).toHaveBeenCalledWith('area', '==', 'Velachery');
  });

  it('does not filter by area when none is given', async () => {
    await call('GET', '/courts', { token: 'good' });

    expect(whereFn).not.toHaveBeenCalled();
  });

  it('applies the search prefix when combined with an area filter', async () => {
    courtsGet.mockResolvedValue({
      docs: [
        { id: 'c1', data: () => ({ name: 'Padel Park', area: 'OMR' }) },
        { id: 'c2', data: () => ({ name: 'Smash Club', area: 'OMR' }) },
      ],
    });

    const { body } = await call('GET', '/courts?area=OMR&search=Pad', { token: 'good' });

    expect(body.courts).toHaveLength(1);
    expect(body.courts[0].name).toBe('Padel Park');
  });
});

describe('POST /courts — admin only', () => {
  const court = { name: 'New Court', area: 'OMR', address: 'Somewhere', isPartner: false };

  it('creates a court for an admin', async () => {
    userGet.mockResolvedValue(asUser(true));

    const { status, body } = await call('POST', '/courts', { token: 'good', body: court });

    expect(status).toBe(201);
    expect(body.name).toBe('New Court');
    expect(courtsAdd).toHaveBeenCalled();
  });

  it('403s a non-admin member', async () => {
    // Courts gate match submission: a player who can add a court can invent a
    // venue and validate a fabricated match against it.
    const { status } = await call('POST', '/courts', { token: 'good', body: court });

    expect(status).toBe(403);
    expect(courtsAdd).not.toHaveBeenCalled();
  });

  it('401s without a token', async () => {
    const { status } = await call('POST', '/courts', { body: court });

    expect(status).toBe(401);
    expect(courtsAdd).not.toHaveBeenCalled();
  });

  it('403s a caller whose isAdmin is truthy but not exactly true', async () => {
    userGet.mockResolvedValue({
      exists: true,
      id: 'uid-1',
      data: () => ({ name: 'X', isAdmin: 'yes', rating: { value: 1500 }, status: 'placement' }),
    });

    expect((await call('POST', '/courts', { token: 'good', body: court })).status).toBe(403);
  });

  it('400s a court with no area', async () => {
    userGet.mockResolvedValue(asUser(true));

    const { status } = await call('POST', '/courts', {
      token: 'good',
      body: { name: 'Nameless' },
    });

    expect(status).toBe(400);
    expect(courtsAdd).not.toHaveBeenCalled();
  });

  it('400s unknown fields rather than storing them', async () => {
    userGet.mockResolvedValue(asUser(true));

    const { status, body } = await call('POST', '/courts', {
      token: 'good',
      body: { ...court, createdAt: '1999-01-01', id: 'forged' },
    });

    expect(status).toBe(400);
    expect(body.rejected).toEqual(expect.arrayContaining(['createdAt', 'id']));
  });
});
