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
const { pairKey, matchupKeyFor } = await import('../../src/services/matchesService.js');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function confirm(matchId, { token = 'good' } = {}) {
  const server = await listen(createApp());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/matches/${matchId}/confirm`,
      {
        method: 'POST',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      },
    );
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const PLAYERS = ['me', 'a2', 'b1', 'b2'];

/** RD 350 / 0 games = placement. Overrides move a player between tiers. */
const user = (id, overrides = {}) => ({
  name: id,
  gender: 'M',
  rating: { value: 1500, rd: 350, sigma: 0.06 },
  status: 'placement',
  gamesPlayed: 0,
  isAdmin: false,
  trustScore: 0,
  ...overrides,
});

const PENDING_MATCH = {
  courtId: 'court-1',
  teamA: ['me', 'a2'],
  teamB: ['b1', 'b2'],
  players: PLAYERS,
  pairs: [pairKey('me', 'a2'), pairKey('b1', 'b2')],
  matchupKey: matchupKeyFor(PLAYERS),
  sets: [{ teamA: 6, teamB: 4 }, { teamA: 6, teamB: 3 }],
  format: 'threeSet',
  winner: 'A',
  gamesA: 12,
  gamesB: 7,
  playedAt: '2026-07-17T10:00:00.000Z',
  status: 'pending',
  reportedBy: 'me',
  confirmedBy: ['me'],
  idempotencyKey: '3f7c1a1e-9b2d-4c8a-9f61-5a0b7c2d8e34',
  createdAt: '2026-07-17T12:00:00.000Z',
};

function seed({ users = {}, match = {} } = {}) {
  const docs = {
    'config/rating': CONFIG,
    'matches/m1': { ...PENDING_MATCH, ...match },
  };

  for (const id of PLAYERS) docs[`users/${id}`] = user(id, users[id] ?? {});

  return docs;
}

const matchDoc = () => db.state.get('matches/m1');
const userDoc = (id) => db.state.get(`users/${id}`);
const deltaFor = (id) => matchDoc().ratingDeltas.find((d) => d.playerId === id);
const historyFor = (id) =>
  [...db.state.entries()]
    .filter(([path]) => path.startsWith(`users/${id}/ratingHistory/`))
    .map(([, data]) => data)
    .filter((entry) => entry.matchId === 'm1');

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  verifyIdToken.mockResolvedValue({ uid: 'me' });
  db = makeFirestore(seed());
});

describe('POST /matches/:id/confirm — the both-teams rule', () => {
  it('does not apply ratings when both confirmations come from one team', async () => {
    // 'me' already confirmed; a2 is their partner. Two signatures, one team.
    verifyIdToken.mockResolvedValue({ uid: 'a2' });

    const { status, body } = await confirm('m1');

    expect(status).toBe(200);
    expect(body.ratingApplied).toBe(false);
    expect(body.status).toBe('pending');
    expect(matchDoc().confirmedBy).toEqual(['me', 'a2']);
    expect(matchDoc().status).toBe('pending');

    // Nothing moved.
    for (const id of PLAYERS) {
      expect(userDoc(id).rating.value).toBe(1500);
      expect(userDoc(id).gamesPlayed).toBe(0);
      expect(historyFor(id)).toEqual([]);
    }
    expect(matchDoc().ratingDeltas).toBeUndefined();
  });

  it('applies ratings when one player from each team has confirmed', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'b1' });

    const { status, body } = await confirm('m1');

    expect(status).toBe(200);
    expect(body.ratingApplied).toBe(true);
    expect(body.status).toBe('confirmed');
    expect(matchDoc().status).toBe('confirmed');

    // Team A won, so A rises and B falls.
    expect(userDoc('me').rating.value).toBeGreaterThan(1500);
    expect(userDoc('a2').rating.value).toBeGreaterThan(1500);
    expect(userDoc('b1').rating.value).toBeLessThan(1500);
    expect(userDoc('b2').rating.value).toBeLessThan(1500);

    for (const id of PLAYERS) {
      expect(userDoc(id).gamesPlayed).toBe(1);
      // RD falls for everyone: the match was informative regardless of who won.
      expect(userDoc(id).rating.rd).toBeLessThan(350);
    }
  });

  it('writes one ratingHistory entry per player, stamped with the config version', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'b1' });
    await confirm('m1');

    for (const id of PLAYERS) {
      const entries = historyFor(id);
      expect(entries).toHaveLength(1);

      const [entry] = entries;
      expect(entry.matchId).toBe('m1');
      expect(entry.ratingBefore).toBe(1500);
      expect(entry.ratingAfter).toBe(userDoc(id).rating.value);
      expect(entry.rdBefore).toBe(350);
      expect(entry.rdAfter).toBe(userDoc(id).rating.rd);
      expect(entry.configVersion).toBe(CONFIG.version);
      expect(entry.createdAt).toBeDefined();
    }
  });

  it('records the derived per-team values, not merely the inputs', async () => {
    // Step 8 auditability: at launch config a mis-derived pairingType changes no
    // rating anyone can see, so the stored value is the only witness.
    verifyIdToken.mockResolvedValue({ uid: 'b1' });
    await confirm('m1');

    const { pairing, multipliers, configVersion, repeatCount } = matchDoc();

    for (const side of ['A', 'B']) {
      expect(pairing[side].pairingType).toBe('same');
      expect(pairing[side].w).toBeGreaterThanOrEqual(0.5);
      expect(PLAYERS).toContain(pairing[side].weakLink);
      expect(pairing[side].hasPlayedTogether).toBe(false);
    }

    expect(multipliers.format).toBe(CONFIG.formatThreeSet);
    expect(multipliers.repeat).toBe(CONFIG.repeatMultipliers[0]);
    expect(multipliers.margin).toBeGreaterThan(CONFIG.marginBase);
    expect(configVersion).toBe(CONFIG.version);
    expect(repeatCount).toBe(0);
  });

  it('derives pairingType per team, so two teams can differ in one match', async () => {
    db = makeFirestore(seed({ users: { a2: { gender: 'F' } } }));
    verifyIdToken.mockResolvedValue({ uid: 'b1' });

    await confirm('m1');

    // Team A is M+F; team B is M+M. Team B must NOT inherit A's mixed pairing
    // just because their opponents were mixed.
    expect(matchDoc().pairing.A.pairingType).toBe('mixed');
    expect(matchDoc().pairing.B.pairingType).toBe('same');
  });

  it('never leaks rating internals to the client', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'b1' });

    const { body } = await confirm('m1');

    // The audit record lives on the document, never in the response.
    for (const field of ['ratingDeltas', 'multipliers', 'pairing', 'configVersion']) {
      expect(body[field]).toBeUndefined();
    }
  });
});

describe('POST /matches/:id/confirm — idempotency', () => {
  it('is a no-op when a player confirms twice', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'me' }); // already in confirmedBy

    const { status, body } = await confirm('m1');

    expect(status).toBe(200);
    expect(body.ratingApplied).toBe(false);
    expect(matchDoc().confirmedBy).toEqual(['me']);
    expect(matchDoc().status).toBe('pending');
  });

  it('never applies ratings twice when a confirmed match is confirmed again', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'b1' });
    await confirm('m1');

    const afterFirst = PLAYERS.map((id) => ({ ...userDoc(id) }));

    // The fourth player confirms a match that is already confirmed.
    verifyIdToken.mockResolvedValue({ uid: 'b2' });
    const { status, body } = await confirm('m1');

    expect(status).toBe(200);
    expect(body.ratingApplied).toBe(false);

    PLAYERS.forEach((id, i) => {
      expect(userDoc(id).rating.value).toBe(afterFirst[i].rating.value);
      expect(userDoc(id).rating.rd).toBe(afterFirst[i].rating.rd);
      expect(userDoc(id).gamesPlayed).toBe(1);
      expect(historyFor(id)).toHaveLength(1);
    });
  });

  it('does not double-apply when the same player re-sends the deciding confirmation', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'b1' });

    await confirm('m1');
    await confirm('m1');

    expect(userDoc('me').gamesPlayed).toBe(1);
    expect(historyFor('me')).toHaveLength(1);
  });
});

describe('POST /matches/:id/confirm — participation', () => {
  it('403s a player who was not in the match', async () => {
    db = makeFirestore({ ...seed(), 'users/outsider': user('outsider') });
    verifyIdToken.mockResolvedValue({ uid: 'outsider' });

    const { status } = await confirm('m1');

    expect(status).toBe(403);
    expect(matchDoc().status).toBe('pending');
  });

  it('404s an unknown match', async () => {
    expect((await confirm('nope')).status).toBe(404);
  });

  it('401s without a token', async () => {
    expect((await confirm('m1', { token: null })).status).toBe(401);
  });
});

describe('POST /matches/:id/confirm — the transaction is atomic', () => {
  it('rolls back cleanly when a write fails part way through', async () => {
    // Fail on the fifth write: two players have already been updated and their
    // history entries buffered by then, so this only passes if nothing commits.
    db = makeFirestore(seed(), {
      onWrite: (_write, index) => {
        if (index === 5) throw new Error('firestore exploded');
      },
    });
    verifyIdToken.mockResolvedValue({ uid: 'b1' });

    const { status } = await confirm('m1');

    expect(status).toBe(500);

    // Not a single partial write survived.
    expect(matchDoc().status).toBe('pending');
    expect(matchDoc().confirmedBy).toEqual(['me']);
    expect(matchDoc().ratingDeltas).toBeUndefined();

    for (const id of PLAYERS) {
      expect(userDoc(id).rating.value).toBe(1500);
      expect(userDoc(id).rating.rd).toBe(350);
      expect(userDoc(id).gamesPlayed).toBe(0);
      expect(historyFor(id)).toEqual([]);
    }
  });

  it('rolls back when a player vanishes mid-pipeline', async () => {
    db = makeFirestore(seed());
    db.state.delete('users/b2');
    verifyIdToken.mockResolvedValue({ uid: 'b1' });

    const { status } = await confirm('m1');

    expect(status).toBe(409);
    expect(matchDoc().status).toBe('pending');
    expect(userDoc('me').gamesPlayed).toBe(0);
  });
});
