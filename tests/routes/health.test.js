import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const get = vi.fn();
const verifyIdToken = vi.fn();

vi.mock('../../src/config/firebase.js', () => ({
  getFirestore: () => ({
    collection: () => ({ doc: () => ({ get }) }),
  }),
  getAuth: () => ({ verifyIdToken }),
}));

const { createApp } = await import('../../src/app.js');

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

async function request(path, headers = {}) {
  const server = await sharedServer();
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => vi.clearAllMocks());

describe('GET /health', () => {
  it('returns ok and a parseable timestamp', async () => {
    const { status, body } = await request('/health');

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });
});

describe('GET /health/db', () => {
  it('reports connected when the read succeeds', async () => {
    get.mockResolvedValue({ exists: false });

    const { status, body } = await request('/health/db');

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', firestore: 'connected' });
    expect(typeof body.latencyMs).toBe('number');
  });

  it('treats a missing doc as a healthy connection', async () => {
    get.mockResolvedValue({ exists: false });

    const { status } = await request('/health/db');

    expect(status).toBe(200);
  });

  it('returns 503 with the reason when the read fails', async () => {
    get.mockRejectedValue(new Error('16 UNAUTHENTICATED: invalid credential'));

    const { status, body } = await request('/health/db');

    expect(status).toBe(503);
    expect(body).toMatchObject({ status: 'error', firestore: 'unreachable' });
    expect(body.reason).toMatch(/UNAUTHENTICATED/);
  });
});

describe('auth is applied to everything except health', () => {
  it('leaves /health open — Render probes it without credentials', async () => {
    const { status } = await request('/health');

    expect(status).toBe(200);
  });

  it('leaves /health/db open', async () => {
    get.mockResolvedValue({ exists: false });
    const { status } = await request('/health/db');

    expect(status).toBe(200);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated call to any other path', async () => {
    // Not a 404: an anonymous caller must not be able to enumerate routes.
    const { status, body } = await request('/nope');

    expect(status).toBe(401);
    expect(body.error).toBe('Unauthorized');
  });

  it('404s an authenticated call to an unknown path', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'uid-1' });
    get.mockResolvedValue({ exists: true, id: 'uid-1', data: () => ({ name: 'Arun' }) });

    const { status, body } = await request('/nope', { Authorization: 'Bearer good' });

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not Found' });
  });

  it('403s an authenticated caller with no user record', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'uid-new' });
    get.mockResolvedValue({ exists: false });

    const { status, body } = await request('/nope', { Authorization: 'Bearer good' });

    expect(status).toBe(403);
    expect(body.error).toBe('Forbidden');
  });
});

/**
 * The unknown-path matrix, pinned.
 *
 * A guard that runs BEFORE routing resolves whether a path exists will turn an
 * unknown path's 404 into its own rejection. That is deliberate at the app level
 * (an anonymous caller must not be able to enumerate routes — Step 10) and it is
 * deliberate under /admin (a non-admin gets a uniform 403 whether or not the
 * admin route exists, which is also non-enumerable). It was a BUG when the admin
 * router was mounted unprefixed, because then a plain member got 403 on every
 * unknown path instead of 404.
 *
 * These tests exist so that regression cannot come back silently.
 */
describe('unknown paths — what each guard mount returns', () => {
  const asAnonymous = {};
  const asMember = { Authorization: 'Bearer member' };
  const asAdmin = { Authorization: 'Bearer admin' };

  beforeEach(() => {
    verifyIdToken.mockImplementation(async (t) => ({ uid: t === 'admin' ? 'admin' : 'member' }));
    get.mockImplementation(async () => ({
      exists: true,
      id: 'u',
      // The doc read is the caller's own profile; isAdmin decides requireAdmin.
      data: () => ({ name: 'U', isAdmin: verifyIdToken.mock.lastCall?.[0] === 'admin' }),
    }));
  });

  it.each([
    // path,             headers,      expected, why
    ['/nope', asAnonymous, 401, 'anonymous cannot enumerate any route'],
    ['/admin/nope', asAnonymous, 401, 'requireAuth fires before the admin gate'],
    ['/nope', asMember, 404, 'a member gets a truthful 404 outside /admin'],
    ['/admin/nope', asMember, 403, 'uniform 403 under /admin — existence not revealed'],
    ['/admin/stats', asMember, 403, 'a real admin route is equally 403 to a member'],
    ['/nope', asAdmin, 404, 'an admin gets a truthful 404 outside /admin'],
    ['/admin/nope', asAdmin, 404, 'an admin gets a truthful 404 inside /admin too'],
  ])('%s as %o -> %i', async (path, headers, expected) => {
    const { status } = await request(path, headers);
    expect(status).toBe(expected);
  });

  it('gives a member the SAME answer for a real and a fake admin route', async () => {
    // The anti-enumeration property under /admin: a non-admin cannot tell which
    // admin routes exist, because both answer 403.
    const real = await request('/admin/stats', asMember);
    const fake = await request('/admin/definitely-not-a-route', asMember);

    expect(real.status).toBe(fake.status);
    expect(real.status).toBe(403);
  });

  it('does not let the admin gate leak onto non-admin paths', async () => {
    // The regression that prompted this block: an unprefixed adminRouter ran
    // requireAdmin for every request, so a member got 403 here instead of 404.
    expect((await request('/nope', asMember)).status).toBe(404);
    expect((await request('/leaderboard/nope', asMember)).status).toBe(404);
  });
});
