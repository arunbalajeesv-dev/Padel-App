import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const verifyIdToken = vi.fn();
const userGet = vi.fn();
const userCreate = vi.fn();
const userUpdate = vi.fn();
const configGet = vi.fn();
const searchGet = vi.fn();

// Captures the search query shape so tests can assert it folds case correctly.
const searchQuery = {};

import { VALID_CONFIG as CONFIG } from '../fixtures/config.js';

// Photo upload (the actual Storage write) is unit-tested in
// tests/services/photoService.test.js; here we only need the route's own
// behaviour — parsing, validation passthrough, and wiring the result into
// updateUser — so the service is a test double.
const validatePhoto = vi.fn(() => []);
const uploadProfilePhoto = vi.fn(() => 'https://storage.googleapis.com/bucket/users/uid-1/profile.jpg');
vi.mock('../../src/services/photoService.js', () => ({ validatePhoto, uploadProfilePhoto }));

// One Firestore double serving both `config/rating` and `users`.
vi.mock('../../src/config/firebase.js', () => ({
  getAuth: () => ({ verifyIdToken }),
  getFirestore: () => ({
    collection: (name) => {
      if (name === 'config') return { doc: () => ({ get: configGet }) };
      return {
        doc: () => ({ get: userGet, create: userCreate, update: userUpdate }),
        orderBy: (field) => {
          searchQuery.orderBy = field;
          return {
            startAt: (v) => {
              searchQuery.startAt = v;
              return {
                endAt: (v2) => {
                  searchQuery.endAt = v2;
                  return { limit: () => ({ get: searchGet }) };
                },
              };
            },
          };
        },
      };
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

async function call(method, path, { token, body } = {}) {
  const server = await sharedServer();
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * A real multipart/form-data request — no manual Content-Type, so fetch sets
 * the correct boundary itself. This exercises the ACTUAL multer parsing in
 * the route, not a stand-in for it.
 */
async function uploadPhoto({ token = 'good', field = 'photo', bytes = 'fake-image-bytes', filename = 'me.jpg', type = 'image/jpeg' } = {}) {
  const server = await sharedServer();
  const form = new FormData();
  if (bytes !== null) {
    form.append(field, new Blob([bytes], { type }), filename);
  }
  const res = await fetch(`http://127.0.0.1:${server.address().port}/users/me/photo`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const EXISTING = {
  phone: '+919000000000',
  name: 'Arun',
  photoUrl: null,
  gender: 'M',
  area: 'Nungambakkam',
  rating: { value: 1714.3, rd: 62, sigma: 0.0601 },
  status: 'established',
  gamesPlayed: 24,
  isAnchor: false,
  isAdmin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-07-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  configGet.mockResolvedValue({ exists: true, data: () => CONFIG });
  verifyIdToken.mockResolvedValue({ uid: 'uid-1', phone_number: '+919000000000' });
  userGet.mockResolvedValue({ exists: true, id: 'uid-1', data: () => EXISTING });
  userCreate.mockResolvedValue({});
  userUpdate.mockResolvedValue({});
  searchGet.mockResolvedValue({ docs: [] });
});

describe('POST /users — the signup bootstrap', () => {
  it('is reachable with a valid token and NO user document', async () => {
    // The whole reason requireVerifiedToken exists. Under blanket requireAuth
    // this would 403 and first-time signup would be impossible.
    userGet.mockResolvedValue({ exists: false });

    const { status, body } = await call('POST', '/users', {
      token: 'good',
      body: { name: 'Newbie', gender: 'F', area: 'OMR' },
    });

    expect(status).toBe(201);
    expect(body.name).toBe('Newbie');
  });

  it('still 401s without a token', async () => {
    const { status } = await call('POST', '/users', { body: { name: 'X', gender: 'M' } });

    expect(status).toBe(401);
  });

  it('still 401s with an invalid token', async () => {
    verifyIdToken.mockRejectedValue(new Error('bad'));

    const { status } = await call('POST', '/users', {
      token: 'bad',
      body: { name: 'X', gender: 'M' },
    });

    expect(status).toBe(401);
  });

  it('starts every player at the config defaults, in placement', async () => {
    userGet.mockResolvedValue({ exists: false });

    await call('POST', '/users', {
      token: 'good',
      body: { name: 'Newbie', gender: 'F' },
    });

    const written = userCreate.mock.calls[0][0];
    expect(written.rating).toEqual({ value: 1500, rd: 350, sigma: 0.06 });
    expect(written.status).toBe('placement');
    expect(written.gamesPlayed).toBe(0);
  });

  it('writes a lowercased nameLower for case-insensitive search', async () => {
    userGet.mockResolvedValue({ exists: false });

    await call('POST', '/users', {
      token: 'good',
      body: { name: '  Arun Kumar  ', gender: 'M' },
    });

    const written = userCreate.mock.calls[0][0];
    expect(written.name).toBe('  Arun Kumar  '); // display name unchanged
    expect(written.nameLower).toBe('arun kumar'); // folded + trimmed
  });

  it('never writes a trustScore field', async () => {
    // trustScore is derived on read from trustLogs. A stored copy would be a
    // stale-derived-field trap: 0 is not a value the formula can return, so a
    // future read would get 0 and mistake it for a real low-trust signal.
    userGet.mockResolvedValue({ exists: false });

    await call('POST', '/users', {
      token: 'good',
      body: { name: 'Newbie', gender: 'F' },
    });

    expect(userCreate.mock.calls[0][0]).not.toHaveProperty('trustScore');
  });

  it('takes phone from the token, never the body', async () => {
    userGet.mockResolvedValue({ exists: false });
    verifyIdToken.mockResolvedValue({ uid: 'uid-2', phone_number: '+919111111111' });

    await call('POST', '/users', {
      token: 'good',
      body: { name: 'Newbie', gender: 'F' },
    });

    expect(userCreate.mock.calls[0][0].phone).toBe('+919111111111');
  });

  it.each(['rating', 'status', 'trustScore', 'isAdmin'])(
    'rejects a client attempt to set %s with a 400',
    async (field) => {
      userGet.mockResolvedValue({ exists: false });

      const { status, body } = await call('POST', '/users', {
        token: 'good',
        body: { name: 'Cheat', gender: 'M', [field]: 'x' },
      });

      expect(status).toBe(400);
      expect(body.rejected).toContain(field);
      expect(userCreate).not.toHaveBeenCalled();
    },
  );

  it('409s when a profile already exists', async () => {
    const { status } = await call('POST', '/users', {
      token: 'good',
      body: { name: 'Arun', gender: 'M' },
    });

    expect(status).toBe(409);
    expect(userCreate).not.toHaveBeenCalled();
  });

  it('409s when it loses a race to a concurrent signup', async () => {
    userGet.mockResolvedValue({ exists: false });
    const err = new Error('ALREADY_EXISTS');
    err.code = 6;
    userCreate.mockRejectedValue(err);

    const { status } = await call('POST', '/users', {
      token: 'good',
      body: { name: 'Newbie', gender: 'F' },
    });

    expect(status).toBe(409);
  });

  it('never returns internal rating state', async () => {
    userGet.mockResolvedValue({ exists: false });

    const { body } = await call('POST', '/users', {
      token: 'good',
      body: { name: 'Newbie', gender: 'F' },
    });

    const json = JSON.stringify(body);
    expect(json).not.toMatch(/"value"|"sigma"|"trustScore"|"isAdmin"|"rating"/);
    expect(body.ratingDisplay).toBeCloseTo(2.333, 2);
  });
});

describe('GET /users/me', () => {
  it('returns the caller profile without internal state', async () => {
    const { status, body } = await call('GET', '/users/me', { token: 'good' });

    expect(status).toBe(200);
    expect(body.name).toBe('Arun');
    expect(body.ratingDisplay).toBeCloseTo(3.33, 2);
    expect(JSON.stringify(body)).not.toMatch(/"value"|"sigma"|"trustScore"/);
  });

  it('403s when the caller has no profile', async () => {
    userGet.mockResolvedValue({ exists: false });

    const { status } = await call('GET', '/users/me', { token: 'good' });

    expect(status).toBe(403);
  });

  it('401s without a token', async () => {
    expect((await call('GET', '/users/me')).status).toBe(401);
  });
});

describe('PATCH /users/me', () => {
  it('updates name, photoUrl and area', async () => {
    await call('PATCH', '/users/me', {
      token: 'good',
      body: { name: 'Arun K', area: 'OMR' },
    });

    const patch = userUpdate.mock.calls[0][0];
    expect(patch.name).toBe('Arun K');
    expect(patch.area).toBe('OMR');
  });

  it.each(['rating', 'status', 'trustScore', 'isAdmin', 'gender', 'gamesPlayed'])(
    'rejects %s with a 400',
    async (field) => {
      const { status, body } = await call('PATCH', '/users/me', {
        token: 'good',
        body: { [field]: 'x' },
      });

      expect(status).toBe(400);
      expect(body.rejected).toContain(field);
      expect(userUpdate).not.toHaveBeenCalled();
    },
  );

  it('rejects gender here specifically — it is admin-only, not immutable', async () => {
    const { status } = await call('PATCH', '/users/me', {
      token: 'good',
      body: { gender: 'F' },
    });

    expect(status).toBe(400);
  });

  it('touches lastActiveAt', async () => {
    await call('PATCH', '/users/me', { token: 'good', body: { name: 'Arun K' } });

    expect(userUpdate.mock.calls[0][0].lastActiveAt).toBeDefined();
  });
});

describe('POST /users/me/photo', () => {
  it('uploads the file and writes the resulting URL via photoUrl', async () => {
    const { status, body } = await uploadPhoto();

    expect(status).toBe(200);
    expect(uploadProfilePhoto).toHaveBeenCalledTimes(1);
    // uploadProfilePhoto's second arg is the multer file object — just check
    // the parsed mimetype and buffer made it through, not the whole shape.
    expect(uploadProfilePhoto.mock.calls[0][0]).toBe('uid-1'); // req.uid
    expect(uploadProfilePhoto.mock.calls[0][1].mimetype).toBe('image/jpeg');
    expect(Buffer.isBuffer(uploadProfilePhoto.mock.calls[0][1].buffer)).toBe(true);

    expect(userUpdate.mock.calls[0][0].photoUrl).toBe(
      'https://storage.googleapis.com/bucket/users/uid-1/profile.jpg',
    );
    expect(body.name).toBe('Arun'); // toSelfView of the (mocked) updated user
  });

  it('400s when no file is attached', async () => {
    // req.file really is undefined here (nothing was sent) — validatePhoto's
    // OWN handling of that is covered for real in photoService.test.js; this
    // only confirms the route surfaces whatever validatePhoto says.
    validatePhoto.mockReturnValueOnce(['A photo file is required.']);

    const { status, body } = await uploadPhoto({ bytes: null });

    expect(status).toBe(400);
    expect(uploadProfilePhoto).not.toHaveBeenCalled();
    expect(body.errors).toContain('A photo file is required.');
  });

  it('400s when validatePhoto rejects the file (wrong type, too large, …)', async () => {
    validatePhoto.mockReturnValueOnce(['Photo must be a JPEG, PNG, or WebP image.']);

    const { status, body } = await uploadPhoto({ type: 'image/gif' });

    expect(status).toBe(400);
    expect(body.errors).toContain('Photo must be a JPEG, PNG, or WebP image.');
    expect(uploadProfilePhoto).not.toHaveBeenCalled();
  });

  it('400s a file over the multer size limit, rather than a raw 500', async () => {
    // Multer's own limit (5MB) fires before validatePhoto ever sees the file.
    const big = 'x'.repeat(6 * 1024 * 1024);
    const { status, body } = await uploadPhoto({ bytes: big });

    expect(status).toBe(400);
    expect(body.errors[0]).toMatch(/5MB/);
    expect(uploadProfilePhoto).not.toHaveBeenCalled();
  });

  it('401s without a token', async () => {
    expect((await uploadPhoto({ token: null })).status).toBe(401);
  });

  it('ignores an unexpected field name — no file reaches the handler', async () => {
    const { status, body } = await uploadPhoto({ field: 'notPhoto' });

    expect(status).toBe(400);
    expect(uploadProfilePhoto).not.toHaveBeenCalled();
    expect(body.errors).toBeDefined();
  });
});

describe('PATCH /users/:id — admin gender correction', () => {
  const asAdmin = (isAdmin) =>
    userGet.mockResolvedValue({
      exists: true,
      id: 'uid-1',
      data: () => ({ ...EXISTING, isAdmin }),
    });

  it('lets an admin change gender', async () => {
    // The mis-tap case: a player on the wrong leaderboard with no self-serve
    // recourse, since one-account-per-phone forbids a second signup.
    asAdmin(true);

    const { status } = await call('PATCH', '/users/uid-2', {
      token: 'good',
      body: { gender: 'F' },
    });

    expect(status).toBe(200);
    expect(userUpdate.mock.calls[0][0].gender).toBe('F');
  });

  it('403s a non-admin', async () => {
    asAdmin(false);

    const { status } = await call('PATCH', '/users/uid-2', {
      token: 'good',
      body: { gender: 'F' },
    });

    expect(status).toBe(403);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('401s without a token', async () => {
    const { status } = await call('PATCH', '/users/uid-2', { body: { gender: 'F' } });

    expect(status).toBe(401);
  });

  it('still refuses rating, status, trustScore and isAdmin', async () => {
    asAdmin(true);

    const { status, body } = await call('PATCH', '/users/uid-2', {
      token: 'good',
      body: { rating: { value: 2500 }, isAdmin: true },
    });

    expect(status).toBe(400);
    expect(body.rejected).toEqual(expect.arrayContaining(['rating', 'isAdmin']));
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('rejects an invalid gender value', async () => {
    asAdmin(true);

    const { status } = await call('PATCH', '/users/uid-2', {
      token: 'good',
      body: { gender: 'X' },
    });

    expect(status).toBe(400);
  });

  it('does not shadow PATCH /users/me', async () => {
    // /users/me is registered first, so `:id` must not swallow it.
    asAdmin(false);

    const { status } = await call('PATCH', '/users/me', {
      token: 'good',
      body: { name: 'Arun K' },
    });

    expect(status).toBe(200);
  });
});

describe('GET /users/search', () => {
  it('is CASE-INSENSITIVE: folds the query and matches against nameLower', async () => {
    // The whole point of the fix. A mixed-case query must match a stored name
    // regardless of case, via the folded nameLower field.
    await call('GET', '/users/search?q=ArUn', { token: 'good' });

    expect(searchQuery.orderBy).toBe('nameLower'); // not `name`
    expect(searchQuery.startAt).toBe('arun'); // lowercased + trimmed
    expect(searchQuery.endAt.startsWith('arun')).toBe(true);
  });

  it('returns name, photoUrl, area and ratingDisplay only', async () => {
    searchGet.mockResolvedValue({
      docs: [{ id: 'uid-2', data: () => ({ ...EXISTING, name: 'Anita' }) }],
    });

    const { status, body } = await call('GET', '/users/search?q=An', { token: 'good' });

    expect(status).toBe(200);
    expect(Object.keys(body.results[0]).sort()).toEqual([
      'area',
      'id',
      'name',
      'photoUrl',
      'ratingDisplay',
    ]);
  });

  it('never leaks phone or rating state for other players', async () => {
    searchGet.mockResolvedValue({
      docs: [{ id: 'uid-2', data: () => ({ ...EXISTING, name: 'Anita' }) }],
    });

    const { body } = await call('GET', '/users/search?q=An', { token: 'good' });

    expect(JSON.stringify(body)).not.toMatch(/"phone"|"value"|"sigma"|"trustScore"|"status"/);
  });

  it('400s without a query', async () => {
    expect((await call('GET', '/users/search', { token: 'good' })).status).toBe(400);
  });

  it('401s without a token', async () => {
    expect((await call('GET', '/users/search?q=An')).status).toBe(401);
  });
});

// GET /users/:id and GET /users/:id/matches need a caller and a target with
// INDEPENDENT identities (e.g. a 404 for the target while the caller still
// resolves fine) — this file's single shared userGet mock cannot distinguish
// them, since requireAuth's own lookup of the caller and the route's lookup
// of :id hit the exact same mock regardless of uid. Those routes are tested
// in tests/routes/userProfile.test.js against the makeFirestore fixture,
// which keys documents by id and can hold both at once.
