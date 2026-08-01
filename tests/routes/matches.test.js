import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import { VALID_CONFIG as CONFIG } from '../fixtures/config.js';

const verifyIdToken = vi.fn();
const configGet = vi.fn();
const userDocGet = vi.fn();
const courtDocGet = vi.fn();
const matchDocGet = vi.fn();
const matchesCreate = vi.fn();

function matchesCollection() {
  const q = {
    where: () => q,
    orderBy: () => q,
    limit: () => q,
    get: vi.fn().mockResolvedValue({ docs: [] }),
    doc: (id) => ({
      create: (doc) => matchesCreate(doc, id),
      get: () => matchDocGet(id),
    }),
  };
  return q;
}

vi.mock('../../src/config/firebase.js', () => ({
  getAuth: () => ({ verifyIdToken }),
  getFirestore: () => ({
    collection: (name) => {
      if (name === 'config') return { doc: () => ({ get: configGet }) };
      if (name === 'courts') return { doc: () => ({ get: courtDocGet }) };
      if (name === 'matches') return matchesCollection();
      return { doc: (id) => ({ get: () => userDocGet(id) }) };
    },
  }),
}));

const { createApp } = await import('../../src/app.js');
const { invalidateConfigCache } = await import('../../src/services/configService.js');
const { matchDocId } = await import('../../src/services/matchesService.js');

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

const PLAYER = (id) => ({
  exists: true,
  id,
  data: () => ({
    name: id,
    gender: 'M',
    rating: { value: 1500, rd: 350, sigma: 0.06 },
    status: 'placement',
    gamesPlayed: 0,
    isAdmin: false,
  }),
});

const KNOWN = new Set(['me', 'a2', 'b1', 'b2']);

const KEY = '3f7c1a1e-9b2d-4c8a-9f61-5a0b7c2d8e34';
const OTHER_KEY = 'c0ffee00-1111-4222-8333-444455556666';

const VALID_BODY = {
  courtId: 'court-1',
  teamA: ['me', 'a2'],
  teamB: ['b1', 'b2'],
  sets: [{ teamA: 6, teamB: 4 }, { teamA: 6, teamB: 3 }],
  playedAt: '2026-07-17T10:00:00.000Z',
  idempotencyKey: KEY,
  sides: { me: 'left', a2: 'right', b1: 'left', b2: 'right' },
};

/** What Firestore throws when create() hits an existing document. */
const alreadyExists = () => Object.assign(new Error('already exists'), { code: 6 });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  configGet.mockResolvedValue({ exists: true, data: () => CONFIG });
  verifyIdToken.mockResolvedValue({ uid: 'me' });
  userDocGet.mockImplementation((id) =>
    Promise.resolve(KNOWN.has(id) ? PLAYER(id) : { exists: false }),
  );
  courtDocGet.mockResolvedValue({ exists: true, id: 'court-1', data: () => ({ name: 'Padel Park', area: 'OMR' }) });
  matchesCreate.mockResolvedValue(undefined);
  matchDocGet.mockResolvedValue({ exists: false });
});

describe('POST /matches — happy path', () => {
  it('creates a pending match', async () => {
    const { status, body } = await post('/matches', { body: VALID_BODY });

    expect(status).toBe(201);
    expect(body.status).toBe('pending');
    expect(body.id).toBe(matchDocId('me', KEY));
  });

  it('records the caller as reporter and sole confirmer', async () => {
    const { body } = await post('/matches', { body: VALID_BODY });

    expect(body.reportedBy).toBe('me');
    expect(body.confirmedBy).toEqual(['me']);
  });

  it('says clearly who still needs to confirm', async () => {
    const { body } = await post('/matches', { body: VALID_BODY });

    // The reporter's own team is covered; the other team must confirm.
    expect(body.confirmation.teamA.confirmed).toBe(true);
    expect(body.confirmation.teamB.confirmed).toBe(false);
    expect(body.awaitingConfirmationFrom).toEqual(['b1', 'b2']);
    expect(body.confirmation.isFullyConfirmed).toBe(false);
  });

  it('stores the derived winner and games', async () => {
    await post('/matches', { body: VALID_BODY });

    const written = matchesCreate.mock.calls[0][0];
    expect(written.winner).toBe('A');
    expect(written.gamesA).toBe(12);
    expect(written.gamesB).toBe(7);
  });

  it('denormalises all four players for querying', async () => {
    await post('/matches', { body: VALID_BODY });

    expect(matchesCreate.mock.calls[0][0].players).toEqual(['me', 'a2', 'b1', 'b2']);
  });

  it('401s without a token', async () => {
    const { status } = await post('/matches', { token: null, body: VALID_BODY });

    expect(status).toBe(401);
    expect(matchesCreate).not.toHaveBeenCalled();
  });
});

describe('POST /matches — court sides', () => {
  it('stores the reported sides for all four players', async () => {
    await post('/matches', { body: VALID_BODY });

    expect(matchesCreate.mock.calls[0][0].sides).toEqual({
      me: 'left', a2: 'right', b1: 'left', b2: 'right',
    });
  });

  it('400s when sides is missing entirely — it is required', async () => {
    const { sides, ...withoutSides } = VALID_BODY;
    const { status, body } = await post('/matches', { body: withoutSides });

    expect(status).toBe(400);
    expect(body.errors.join(' ')).toMatch(/sides/);
    expect(matchesCreate).not.toHaveBeenCalled();
  });

  it('400s when a player is missing from sides', async () => {
    const { status, body } = await post('/matches', {
      body: { ...VALID_BODY, sides: { me: 'left', a2: 'right', b1: 'left' } },
    });

    expect(status).toBe(400);
    expect(body.errors.join(' ')).toMatch(/sides\.b2/);
  });

  it('400s on a side value that is not left or right', async () => {
    const { status, body } = await post('/matches', {
      body: { ...VALID_BODY, sides: { ...VALID_BODY.sides, b2: 'middle' } },
    });

    expect(status).toBe(400);
    expect(body.errors.join(' ')).toMatch(/sides\.b2/);
  });

  it('400s when teammates claim the same side — one plays left, one right', async () => {
    const { status, body } = await post('/matches', {
      body: { ...VALID_BODY, sides: { ...VALID_BODY.sides, me: 'left', a2: 'left' } },
    });

    expect(status).toBe(400);
    expect(body.errors.join(' ')).toMatch(/teamA.*same side/);
    expect(matchesCreate).not.toHaveBeenCalled();
  });

  it('allows both teams to use the same left/right split — sides are per-team, not absolute', async () => {
    // teamA and teamB each have a left and a right player. These are relative
    // to each team, so this is the NORMAL case, not a conflict.
    const { status } = await post('/matches', {
      body: { ...VALID_BODY, sides: { me: 'left', a2: 'right', b1: 'left', b2: 'right' } },
    });

    expect(status).toBe(201);
  });
});

describe('POST /matches — the body is allowlisted', () => {
  it.each([
    ['format', { format: 'single' }],
    ['status', { status: 'confirmed' }],
    ['reportedBy', { reportedBy: 'someone-else' }],
    ['confirmedBy', { confirmedBy: ['me', 'a2', 'b1', 'b2'] }],
    ['winner', { winner: 'A' }],
    ['an unknown field', { nonsense: true }],
  ])('400s on a client-supplied %s rather than ignoring it', async (_label, extra) => {
    const { status, body } = await post('/matches', { body: { ...VALID_BODY, ...extra } });

    expect(status).toBe(400);
    expect(body.rejected).toEqual([Object.keys(extra)[0]]);
    expect(matchesCreate).not.toHaveBeenCalled();
  });

  it('names every rejected field, so a broken client can see all of them at once', async () => {
    const { body } = await post('/matches', {
      body: { ...VALID_BODY, format: 'single', status: 'confirmed' },
    });

    expect(body.rejected).toEqual(['format', 'status']);
    expect(body.reason).toMatch(/format, status/);
  });
});

describe('POST /matches — format is derived, never accepted', () => {
  it('derives single from a one-set score', async () => {
    await post('/matches', { body: { ...VALID_BODY, sets: [{ teamA: 6, teamB: 4 }] } });

    expect(matchesCreate.mock.calls[0][0].format).toBe('single');
  });

  it('derives threeSet from a straight-sets 2-0, not a discount', async () => {
    await post('/matches', {
      body: { ...VALID_BODY, sets: [{ teamA: 6, teamB: 0 }, { teamA: 6, teamB: 0 }] },
    });

    expect(matchesCreate.mock.calls[0][0].format).toBe('threeSet');
  });

  it('never writes a server-owned field from the body', async () => {
    await post('/matches', { body: VALID_BODY });

    const written = matchesCreate.mock.calls[0][0];
    expect(written.status).toBe('pending');
    expect(written.reportedBy).toBe('me');
    expect(written.confirmedBy).toEqual(['me']);
  });
});

describe('POST /matches — score validation', () => {
  it.each([
    ['8-6', [{ teamA: 8, teamB: 6 }]],
    ['6-5', [{ teamA: 6, teamB: 5 }]],
    ['a level set', [{ teamA: 6, teamB: 6 }]],
    ['zero sets', []],
    ['four sets', [
      { teamA: 6, teamB: 4 }, { teamA: 2, teamB: 6 },
      { teamA: 6, teamB: 3 }, { teamA: 6, teamB: 2 },
    ]],
    ['an unfinished two-set split', [{ teamA: 6, teamB: 4 }, { teamA: 3, teamB: 6 }]],
    ['a third set after 2-0', [
      { teamA: 6, teamB: 4 }, { teamA: 6, teamB: 2 }, { teamA: 6, teamB: 3 },
    ]],
  ])('rejects %s', async (_label, sets) => {
    const { status } = await post('/matches', { body: { ...VALID_BODY, sets } });

    expect(status).toBe(400);
    expect(matchesCreate).not.toHaveBeenCalled();
  });

  it('rejects a championship tiebreak with the validator message', async () => {
    const { status, body } = await post('/matches', {
      body: {
        ...VALID_BODY,
        sets: [{ teamA: 6, teamB: 4 }, { teamA: 2, teamB: 6 }, { teamA: 10, teamB: 8 }],
      },
    });

    expect(status).toBe(400);
    expect(body.errors[0]).toMatch(/championship tiebreak/i);
  });

  it('passes the validator errors through for the UI', async () => {
    const { body } = await post('/matches', {
      body: { ...VALID_BODY, sets: [{ teamA: 8, teamB: 6 }] },
    });

    expect(body.errors[0]).toMatch(/Legal endings are 6-0, 6-1/);
  });
});

describe('POST /matches — participants', () => {
  it('403s when the caller is not one of the four', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'outsider' });
    userDocGet.mockImplementation((id) =>
      Promise.resolve(id === 'outsider' ? PLAYER(id) : KNOWN.has(id) ? PLAYER(id) : { exists: false }),
    );

    const { status } = await post('/matches', { body: VALID_BODY });

    expect(status).toBe(403);
    expect(matchesCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['a player on both teams', { teamA: ['me', 'a2'], teamB: ['me', 'b2'] }],
    ['the same player twice on one team', { teamA: ['me', 'me'], teamB: ['b1', 'b2'] }],
  ])('rejects %s', async (_label, teams) => {
    const { status, body } = await post('/matches', { body: { ...VALID_BODY, ...teams } });

    expect(status).toBe(400);
    expect(body.errors[0]).toMatch(/distinct/);
  });

  it('400s when a player does not exist', async () => {
    const { status, body } = await post('/matches', {
      body: {
        ...VALID_BODY,
        teamB: ['ghost', 'b2'],
        // A valid-shaped sides map for ghost/b2 — this test is about the
        // unknown-player check, not sides validation, so it should not trip
        // on a coincidentally-missing sides entry for 'ghost'.
        sides: { ...VALID_BODY.sides, ghost: 'left' },
      },
    });

    expect(status).toBe(400);
    expect(body.errors[0]).toMatch(/Unknown player uid\(s\): ghost/);
    expect(matchesCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['a three-player team', { teamA: ['me', 'a2', 'b1'] }],
    ['a one-player team', { teamA: ['me'] }],
    ['a non-array team', { teamA: 'me' }],
  ])('rejects %s', async (_label, teams) => {
    const { status } = await post('/matches', { body: { ...VALID_BODY, ...teams } });

    expect(status).toBe(400);
  });
});

describe('POST /matches — court must exist', () => {
  it('400s for an unknown court', async () => {
    // Anti-abuse: without this a player could invent a venue and validate a
    // fabricated match against it.
    courtDocGet.mockResolvedValue({ exists: false });

    const { status, body } = await post('/matches', { body: VALID_BODY });

    expect(status).toBe(400);
    expect(body.errors[0]).toMatch(/No court with id/);
    expect(matchesCreate).not.toHaveBeenCalled();
  });

  it('400s for a missing courtId', async () => {
    const { courtId, ...noCourt } = VALID_BODY;

    expect((await post('/matches', { body: noCourt })).status).toBe(400);
  });
});

describe('POST /matches — idempotency key', () => {
  it.each([
    ['a missing key', undefined],
    ['a non-UUID string', 'submit-1'],
    ['an empty string', ''],
    ['a number', 12345],
  ])('400s on %s', async (_label, idempotencyKey) => {
    const { status, body } = await post('/matches', {
      body: { ...VALID_BODY, idempotencyKey },
    });

    expect(status).toBe(400);
    expect(body.errors.some((e) => /idempotencyKey must be a UUID/.test(e))).toBe(true);
    expect(matchesCreate).not.toHaveBeenCalled();
  });

  it('stores the key on the match', async () => {
    await post('/matches', { body: VALID_BODY });

    expect(matchesCreate.mock.calls[0][0].idempotencyKey).toBe(KEY);
  });

  it('derives the document id from the key, so a double-tap collides exactly', async () => {
    await post('/matches', { body: VALID_BODY });

    expect(matchesCreate.mock.calls[0][1]).toBe(matchDocId('me', KEY));
  });

  it('returns the existing match with 200 when a key is resent', async () => {
    const stored = {
      ...VALID_BODY,
      players: ['me', 'a2', 'b1', 'b2'],
      winner: 'A',
      format: 'threeSet',
      status: 'pending',
      reportedBy: 'me',
      confirmedBy: ['me'],
    };
    matchesCreate.mockRejectedValue(alreadyExists());
    matchDocGet.mockResolvedValue({ exists: true, id: matchDocId('me', KEY), data: () => stored });

    const { status, body } = await post('/matches', { body: VALID_BODY });

    // 200, not 201: this request created nothing. Not 409 either — a double-tap
    // is not an error the player should be shown.
    expect(status).toBe(200);
    expect(body.id).toBe(matchDocId('me', KEY));
  });

  it('does not overwrite a match that has since collected confirmations', async () => {
    matchesCreate.mockRejectedValue(alreadyExists());
    matchDocGet.mockResolvedValue({
      exists: true,
      id: matchDocId('me', KEY),
      data: () => ({ ...VALID_BODY, players: [], confirmedBy: ['me', 'b1'], status: 'pending' }),
    });

    const { body } = await post('/matches', { body: VALID_BODY });

    expect(body.confirmedBy).toEqual(['me', 'b1']);
  });

  it('lets the same four players log consecutive single sets, minutes apart', async () => {
    // The regression this replaced a time window to fix. Single sets run 25-40
    // minutes, so two genuine consecutive sets land inside any 30-minute window
    // — and that is the format Step 9 showed wins per court hour. Distinct keys
    // mean both succeed; only a resent key is a duplicate.
    const first = await post('/matches', {
      body: { ...VALID_BODY, sets: [{ teamA: 6, teamB: 4 }], playedAt: '2026-07-17T10:00:00.000Z' },
    });
    const second = await post('/matches', {
      body: {
        ...VALID_BODY,
        sets: [{ teamA: 4, teamB: 6 }],
        playedAt: '2026-07-17T10:28:00.000Z',
        idempotencyKey: OTHER_KEY,
      },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(matchesCreate).toHaveBeenCalledTimes(2);
    expect(matchesCreate.mock.calls[0][1]).not.toBe(matchesCreate.mock.calls[1][1]);
  });

  it('scopes a key to its reporter, so one client cannot claim another\'s match id', async () => {
    expect(matchDocId('me', KEY)).not.toBe(matchDocId('b1', KEY));
  });
});
