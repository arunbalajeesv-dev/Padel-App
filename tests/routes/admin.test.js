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

async function req(method, path, { token = 'admin', body } = {}) {
  const server = await listen(createApp());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

const get = (p, o) => req('GET', p, o);
const post = (p, o) => req('POST', p, o);
const patch = (p, o) => req('PATCH', p, o);
const del = (p, o) => req('DELETE', p, o);

const userDoc = (over = {}) => ({
  name: over.name ?? 'u', gender: 'M',
  rating: { value: 1500, rd: 80, sigma: 0.06 },
  status: 'established', gamesPlayed: 20, isAdmin: false, isAnchor: false,
  lastActiveAt: '2026-07-17T00:00:00.000Z', ...over,
});

function baseDocs() {
  return {
    'config/rating': CONFIG,
    'users/admin': userDoc({ name: 'Admin', isAdmin: true }),
    'users/alice': userDoc({ name: 'Alice' }),
    'users/bob': userDoc({ name: 'Bob' }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  // Token 'admin' -> admin user; token 'plain' -> a non-admin.
  verifyIdToken.mockImplementation(async (t) => ({ uid: t === 'plain' ? 'alice' : 'admin' }));
  db = makeFirestore(baseDocs());
});

describe('admin surface — access control', () => {
  it('403s a non-admin authenticated user', async () => {
    expect((await get('/admin/stats', { token: 'plain' })).status).toBe(403);
  });

  it('401s an unauthenticated caller', async () => {
    expect((await get('/admin/stats', { token: null })).status).toBe(401);
  });

  it('does not 403 an unknown non-admin path — it still 404s', async () => {
    // The admin gate must guard only the /admin subtree, not every request.
    expect((await get('/nope', { token: 'plain' })).status).toBe(404);
  });
});

describe('GET /admin/stats', () => {
  it('returns totals and an RD histogram', async () => {
    db = makeFirestore({
      ...baseDocs(),
      'users/c': userDoc({ name: 'C', rating: { value: 1600, rd: 220, sigma: 0.06 } }),
      'matches/m1': { status: 'confirmed', playedAt: '2026-07-17T10:00:00.000Z' },
      'matches/m2': { status: 'pending', playedAt: '2026-07-01T10:00:00.000Z' },
      'disputes/d1': { status: 'open', matchId: 'm1' },
      'disputes/d2': { status: 'resolved', matchId: 'm2' },
    });

    const { status, body } = await get('/admin/stats');

    expect(status).toBe(200);
    expect(body.totalMatches).toBe(2);
    expect(body.confirmedMatches).toBe(1);
    expect(body.pendingDisputes).toBe(1); // open counts, resolved does not
    expect(body.matchesThisWeek).toBe(1); // only the confirmed recent one
    expect(body.totalPlayers).toBe(4);

    const total = body.rdHistogram.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(4); // every player lands in exactly one bucket
    // admin/alice/bob at RD 80 -> the 50-100 bucket; c at 220 -> 200-250.
    expect(body.rdHistogram.find((b) => b.label === '50-100').count).toBe(3);
    expect(body.rdHistogram.find((b) => b.label === '200-250').count).toBe(1);
  });
});

describe('POST /admin/anchors', () => {
  it('sets and unsets the isAnchor flag', async () => {
    const set = await post('/admin/anchors', { body: { userId: 'alice', isAnchor: true } });
    expect(set.status).toBe(200);
    expect(set.body.isAnchor).toBe(true);
    expect(db.state.get('users/alice').isAnchor).toBe(true);

    await post('/admin/anchors', { body: { userId: 'alice', isAnchor: false } });
    expect(db.state.get('users/alice').isAnchor).toBe(false);
  });

  it('does not touch lastActiveAt in a way that changes the rating', async () => {
    await post('/admin/anchors', { body: { userId: 'alice', isAnchor: true } });
    expect(db.state.get('users/alice').rating.value).toBe(1500);
  });

  it('404s an unknown user', async () => {
    expect((await post('/admin/anchors', { body: { userId: 'ghost', isAnchor: true } })).status).toBe(404);
  });

  it('400s a bad body', async () => {
    expect((await post('/admin/anchors', { body: { userId: 'alice' } })).status).toBe(400);
    expect((await post('/admin/anchors', { body: { userId: 'alice', isAnchor: 'yes' } })).status).toBe(400);
  });
});

describe('POST /admin/courts', () => {
  it('creates a court', async () => {
    const { status, body } = await post('/admin/courts', {
      body: { name: 'Padel Park', area: 'OMR' },
    });
    expect(status).toBe(201);
    expect(body.name).toBe('Padel Park');
  });

  it('400s an unknown field', async () => {
    const { status, body } = await post('/admin/courts', {
      body: { name: 'X', area: 'OMR', capacity: 4 },
    });
    expect(status).toBe(400);
    expect(body.rejected).toEqual(['capacity']);
  });
});

describe('invite codes CRUD', () => {
  it('creates, lists, updates and deletes a code', async () => {
    const created = await post('/admin/invite-codes', { body: { code: 'beta-1', phase: 'beta' } });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe('BETA-1'); // normalised uppercase
    expect(created.body.active).toBe(true);

    const listed = await get('/admin/invite-codes');
    expect(listed.body.inviteCodes).toHaveLength(1);

    const toggled = await patch('/admin/invite-codes/BETA-1', { body: { active: false } });
    expect(toggled.status).toBe(200);
    expect(toggled.body.active).toBe(false);

    const removed = await del('/admin/invite-codes/BETA-1');
    expect(removed.status).toBe(204);
    expect((await get('/admin/invite-codes')).body.inviteCodes).toHaveLength(0);
  });

  it('409s a duplicate code (case-insensitively)', async () => {
    const first = await post('/admin/invite-codes', { body: { code: 'DUPE', phase: 'beta' } });
    expect(first.status).toBe(201);
    const again = await post('/admin/invite-codes', { body: { code: 'dupe', phase: 'beta' } });
    expect(again.status).toBe(409);
  });

  it('400s an invalid code or missing phase', async () => {
    expect((await post('/admin/invite-codes', { body: { code: 'x', phase: 'beta' } })).status).toBe(400);
    expect((await post('/admin/invite-codes', { body: { code: 'GOOD-1' } })).status).toBe(400);
  });

  it('404s updating or deleting a missing code', async () => {
    expect((await patch('/admin/invite-codes/NOPE', { body: { active: false } })).status).toBe(404);
    expect((await del('/admin/invite-codes/NOPE')).status).toBe(404);
  });
});

describe('disputes queue and resolve', () => {
  function seedDispute(over = {}) {
    db = makeFirestore({
      ...baseDocs(),
      'matches/m1': {
        teamA: ['alice', 'x'], teamB: ['bob', 'y'], players: ['alice', 'x', 'bob', 'y'],
        sets: [{ teamA: 6, teamB: 4 }], winner: 'A', playedAt: '2026-07-17T10:00:00.000Z',
        status: over.matchStatus ?? 'disputed', hasOpenDispute: true,
      },
      'disputes/d1': {
        matchId: 'm1', raisedBy: 'alice', reason: 'wrong score entirely here',
        evidenceUrl: null, status: 'open', ratingsApplied: over.ratingsApplied ?? false,
        matchStatusAtDispute: 'pending', createdAt: '2026-07-17T11:00:00.000Z',
      },
    });
  }

  it('lists the live queue with match context', async () => {
    seedDispute();
    const { status, body } = await get('/admin/disputes');

    expect(status).toBe(200);
    expect(body.disputes).toHaveLength(1);
    expect(body.disputes[0].matchId).toBe('m1');
    expect(body.disputes[0].match.winner).toBe('A'); // joined context
  });

  it('excludes resolved disputes from the queue', async () => {
    seedDispute();
    db.state.set('disputes/d1', { ...db.state.get('disputes/d1'), status: 'resolved' });
    expect((await get('/admin/disputes')).body.disputes).toHaveLength(0);
  });

  it('dismiss clears the flag and records the decision', async () => {
    seedDispute();
    const { status, body } = await post('/admin/disputes/d1/resolve', {
      body: { action: 'dismiss', note: 'checked with both teams, fine' },
    });

    expect(status).toBe(200);
    expect(db.state.get('disputes/d1').status).toBe('resolved');
    expect(db.state.get('disputes/d1').resolvedBy).toBe('admin');
    expect(db.state.get('matches/m1').hasOpenDispute).toBe(false);
    expect(db.state.get('matches/m1').status).toBe('disputed'); // dismiss does not void
    expect(body.ratingReversalRequiredManually).toBe(false);
  });

  it('void rejects a never-rated match', async () => {
    seedDispute({ ratingsApplied: false });
    await post('/admin/disputes/d1/resolve', {
      body: { action: 'void', note: 'fabricated match, voided' },
    });
    expect(db.state.get('matches/m1').status).toBe('rejected');
  });

  it('void on a RATED match never reverses — it flags for manual handling', async () => {
    seedDispute({ ratingsApplied: true, matchStatus: 'confirmed' });
    const { body } = await post('/admin/disputes/d1/resolve', {
      body: { action: 'void', note: 'confirmed collusion, needs manual unwind' },
    });

    // The rated match keeps its status and its deltas — reversal cascades and is manual.
    expect(db.state.get('matches/m1').status).toBe('confirmed');
    expect(db.state.get('matches/m1').hasOpenDispute).toBe(false);
    expect(body.ratingReversalRequiredManually).toBe(true);
  });

  it('409s resolving an already-resolved dispute', async () => {
    seedDispute();
    await post('/admin/disputes/d1/resolve', { body: { action: 'dismiss', note: 'all good here' } });
    const again = await post('/admin/disputes/d1/resolve', { body: { action: 'dismiss', note: 'again now' } });
    expect(again.status).toBe(409);
  });

  it('400s a bad resolve body and 404s a missing dispute', async () => {
    seedDispute();
    expect((await post('/admin/disputes/d1/resolve', { body: { action: 'nope', note: 'valid note' } })).status).toBe(400);
    expect((await post('/admin/disputes/ghost/resolve', { body: { action: 'dismiss', note: 'valid note' } })).status).toBe(404);
  });
});

describe('GET /admin/alerts/weekly-gain', () => {
  function seedGains() {
    const hist = (id, i, before, after, daysAgo) => [
      `users/${id}/ratingHistory/h${i}`,
      {
        matchId: `m${i}`, ratingBefore: before, ratingAfter: after,
        rdBefore: 90, rdAfter: 80, configVersion: 1,
        createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      },
    ];
    db = makeFirestore({
      ...baseDocs(),
      // Alice: big gain across ONE opponent pairing -> looks like a ring.
      ...Object.fromEntries([hist('alice', 1, 1500, 1620, 2), hist('alice', 2, 1620, 1720, 1)]),
      'matches/ma1': { players: ['alice', 'p', 'bob', 'q'], teamA: ['alice', 'p'], teamB: ['bob', 'q'], status: 'confirmed', playedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      'matches/ma2': { players: ['alice', 'p', 'bob', 'q'], teamA: ['alice', 'p'], teamB: ['bob', 'q'], status: 'confirmed', playedAt: new Date(Date.now() - 1 * 86_400_000).toISOString() },
      // Bob: small gain, under threshold.
      ...Object.fromEntries([hist('bob', 3, 1500, 1540, 1)]),
    });
  }

  it('surfaces only players above the threshold, with collusion context', async () => {
    seedGains();
    const { status, body } = await get('/admin/alerts/weekly-gain');

    expect(status).toBe(200);
    expect(body.threshold).toBe(CONFIG.weeklyGainAlertThreshold);

    const ids = body.players.map((p) => p.userId);
    expect(ids).toContain('alice'); // gained 220 > 200
    expect(ids).not.toContain('bob'); // gained 40 < 200

    const alice = body.players.find((p) => p.userId === 'alice');
    expect(alice.gain).toBe(220);
    expect(alice.matchCount).toBe(2);
    expect(alice.distinctOpponents).toBe(2); // bob + q — the human reads this signal
  });

  it('ignores gains older than the window', async () => {
    db = makeFirestore({
      ...baseDocs(),
      'users/alice/ratingHistory/old': {
        matchId: 'm', ratingBefore: 1400, ratingAfter: 1700, rdBefore: 90, rdAfter: 80,
        configVersion: 1, createdAt: new Date(Date.now() - 20 * 86_400_000).toISOString(),
      },
    });
    expect((await get('/admin/alerts/weekly-gain')).body.players).toEqual([]);
  });

  it('does not count losses toward gain', async () => {
    db = makeFirestore({
      ...baseDocs(),
      'users/alice/ratingHistory/h1': { matchId: 'm', ratingBefore: 1700, ratingAfter: 1400, rdBefore: 90, rdAfter: 80, configVersion: 1, createdAt: new Date().toISOString() },
    });
    expect((await get('/admin/alerts/weekly-gain')).body.players).toEqual([]);
  });
});

describe('GET /admin/trust', () => {
  function seedTrust() {
    const log = (i, subject, score) => [
      `trustLogs/t${i}`,
      { subjectUid: subject, fromUid: 'x', matchId: 'm', score, createdAt: '2026-07-17T00:00:00.000Z' },
    ];
    db = makeFirestore({
      ...baseDocs(),
      ...Object.fromEntries([
        log(1, 'alice', 5), log(2, 'alice', 4),
        log(3, 'bob', 1), log(4, 'bob', 2), log(5, 'bob', 1),
      ]),
    });
  }

  it('returns trust scores lowest first, derived from trustLogs', async () => {
    seedTrust();
    const { status, body } = await get('/admin/trust');

    expect(status).toBe(200);
    // Bob (poor sportsmanship) sorts before Alice.
    expect(body.trust[0].userId).toBe('bob');
    expect(body.trust[0].trustScore).toBeLessThan(body.trust[1].trustScore);
    expect(body.trust.find((t) => t.userId === 'alice').reviewCount).toBe(2);
  });

  it('returns a neutral 0.5 for a player with no feedback', async () => {
    seedTrust();
    const { body } = await get('/admin/trust/admin'); // admin received no feedback
    expect(body.trustScore).toBe(0.5);
    expect(body.rawMean).toBeNull();
  });

  it('404s trust for an unknown user', async () => {
    expect((await get('/admin/trust/ghost')).status).toBe(404);
  });
});
