import { describe, it, expect, vi, beforeEach } from 'vitest';

// The API base URL is read at import time from import.meta.env.
vi.stubEnv('VITE_API_BASE_URL', 'http://api.test');

const { request, setTokenProvider } = await import('./client.js');
const { ApiError } = await import('./ApiError.js');
const api = await import('./index.js');

/** Build a fetch Response stand-in. */
const respond = (status, body, { text } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (text !== undefined ? text : body === undefined ? '' : JSON.stringify(body)),
});

beforeEach(() => {
  vi.restoreAllMocks();
  setTokenProvider(null);
});

describe('the bearer token is fetched fresh on every request', () => {
  it('asks the provider once per request, never reusing a cached string', async () => {
    // The whole point: ID tokens expire hourly and the SDK refreshes them, but
    // only if we ask each time. A cached token logs everyone out after an hour.
    const provider = vi.fn().mockResolvedValue('tok-1');
    setTokenProvider(provider);
    global.fetch = vi.fn().mockResolvedValue(respond(200, { ok: true }));

    await request('/users/me');
    await request('/users/me');
    await request('/users/me');

    expect(provider).toHaveBeenCalledTimes(3);
  });

  it('sends whatever the provider currently returns, so a refresh takes effect', async () => {
    const provider = vi.fn()
      .mockResolvedValueOnce('old-token')
      .mockResolvedValueOnce('refreshed-token');
    setTokenProvider(provider);
    global.fetch = vi.fn().mockResolvedValue(respond(200, {}));

    await request('/users/me');
    await request('/users/me');

    const [, first] = global.fetch.mock.calls[0];
    const [, second] = global.fetch.mock.calls[1];
    expect(first.headers.Authorization).toBe('Bearer old-token');
    expect(second.headers.Authorization).toBe('Bearer refreshed-token');
  });

  it('omits the header entirely when signed out', async () => {
    setTokenProvider(async () => null);
    global.fetch = vi.fn().mockResolvedValue(respond(200, {}));

    await request('/leaderboard');

    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});

describe('errors are typed so screens can branch on them', () => {
  beforeEach(() => setTokenProvider(async () => 'tok'));

  it('throws ApiError carrying the status and body', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      respond(409, { error: 'Conflict', reason: 'this match already has an open dispute' }),
    );

    const err = await request('/matches/m1/dispute', { method: 'POST' }).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.reason).toBe('this match already has an open dispute');
    expect(err.body.error).toBe('Conflict');
  });

  it('exposes validation messages as a list', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      respond(400, { error: 'Bad Request', errors: ['sets must be an array.', 'courtId is required.'] }),
    );

    const err = await request('/matches', { method: 'POST' }).catch((e) => e);

    expect(err.status).toBe(400);
    expect(err.errors).toEqual(['sets must be an array.', 'courtId is required.']);
  });

  it('exposes rejected field names', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      respond(400, { error: 'Bad Request', reason: 'x', rejected: ['format'] }),
    );

    const err = await request('/matches', { method: 'POST' }).catch((e) => e);

    expect(err.rejected).toEqual(['format']);
  });

  it('distinguishes an expired token from an invalid one', async () => {
    // The backend separates these so the client can refresh silently rather
    // than dumping a signed-in player at a login screen.
    global.fetch = vi.fn().mockResolvedValue(
      respond(401, { error: 'Unauthorized', reason: 'expired token' }),
    );
    const expired = await request('/users/me').catch((e) => e);
    expect(expired.isExpiredToken).toBe(true);

    global.fetch = vi.fn().mockResolvedValue(
      respond(401, { error: 'Unauthorized', reason: 'invalid token' }),
    );
    const invalid = await request('/users/me').catch((e) => e);
    expect(invalid.isExpiredToken).toBe(false);
  });

  it('recognises the no-profile-yet 403 as a routing signal, not a failure', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      respond(403, { error: 'Forbidden', reason: 'no user record for this account' }),
    );

    const err = await request('/users/me').catch((e) => e);

    expect(err.isMissingProfile).toBe(true);
  });

  it('does not mistake an ordinary 403 for a missing profile', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      respond(403, { error: 'Forbidden', reason: 'admin only' }),
    );

    expect((await request('/admin/stats').catch((e) => e)).isMissingProfile).toBe(false);
  });

  it('survives a non-JSON error body without masking the status', async () => {
    // A proxy or error page can return HTML; the status is what the caller needs.
    global.fetch = vi.fn().mockResolvedValue(respond(502, undefined, { text: '<html>oops</html>' }));

    const err = await request('/users/me').catch((e) => e);

    expect(err.status).toBe(502);
    expect(err.body).toBeNull();
  });

  it('reports a network failure as status 0 rather than throwing raw', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const err = await request('/users/me').catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it('returns null for 204 rather than trying to parse a body', async () => {
    global.fetch = vi.fn().mockResolvedValue(respond(204));
    await expect(request('/admin/invite-codes/X', { method: 'DELETE' })).resolves.toBeNull();
  });
});

describe('typed endpoint methods', () => {
  beforeEach(() => {
    setTokenProvider(async () => 'tok');
    global.fetch = vi.fn().mockResolvedValue(respond(200, {}));
  });

  const urlOf = (call = 0) => global.fetch.mock.calls[call][0];
  const optsOf = (call = 0) => global.fetch.mock.calls[call][1];

  it('builds query strings and drops absent filters', async () => {
    await api.getLeaderboard({ pool: 'men', area: undefined, period: '30d' });

    const url = new URL(urlOf());
    expect(url.pathname).toBe('/leaderboard');
    expect(url.searchParams.get('pool')).toBe('men');
    expect(url.searchParams.get('period')).toBe('30d');
    expect(url.searchParams.has('area')).toBe(false); // not `area=undefined`
  });

  it('encodes path parameters', async () => {
    await api.confirmMatch('match/with slash');
    expect(new URL(urlOf()).pathname).toBe('/matches/match%2Fwith%20slash/confirm');
  });

  it('sends JSON bodies with the right method', async () => {
    await api.patchMe({ name: 'Arun' });

    expect(optsOf().method).toBe('PATCH');
    expect(optsOf().headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(optsOf().body)).toEqual({ name: 'Arun' });
  });

  it('refuses createMatch without an idempotency key', async () => {
    // A missing key means a retry would silently create a second match.
    await expect(
      api.createMatch({ courtId: 'c', teamA: ['a', 'b'], teamB: ['c', 'd'], sets: [], playedAt: 'x' }),
    ).rejects.toThrow(/idempotencyKey/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('passes a supplied idempotency key straight through', async () => {
    const key = api.newIdempotencyKey();
    await api.createMatch({
      courtId: 'c', teamA: ['a', 'b'], teamB: ['c', 'd'],
      sets: [{ teamA: 6, teamB: 4 }], playedAt: '2026-07-18T10:00:00.000Z',
      idempotencyKey: key,
    });

    expect(JSON.parse(optsOf().body).idempotencyKey).toBe(key);
  });

  it('uploads a photo as multipart form data, with no explicit Content-Type', async () => {
    // Setting Content-Type manually would strip the multipart boundary the
    // browser generates, and the server could not parse the body at all.
    const file = new File(['bytes'], 'me.jpg', { type: 'image/jpeg' });
    await api.uploadPhoto(file);

    expect(optsOf().method).toBe('POST');
    expect(optsOf().headers['Content-Type']).toBeUndefined();
    expect(optsOf().body).toBeInstanceOf(FormData);
    expect(optsOf().body.get('photo')).toBe(file);
  });

  it('mints a distinct key per call, so callers must hold their own', async () => {
    expect(api.newIdempotencyKey()).not.toBe(api.newIdempotencyKey());
    expect(api.newIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
