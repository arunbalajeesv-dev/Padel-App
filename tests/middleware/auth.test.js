import { describe, it, expect, vi, beforeEach } from 'vitest';

const verifyIdToken = vi.fn();
const userGet = vi.fn();

vi.mock('../../src/config/firebase.js', () => ({
  getAuth: () => ({ verifyIdToken }),
  getFirestore: () => ({ collection: () => ({ doc: () => ({ get: userGet }) }) }),
}));

const { requireAuth, requireAdmin } = await import('../../src/middleware/auth.js');

/** Minimal Express doubles — no server, no network. */
function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

const mockReq = (authorization) => ({
  get: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
});

const userDoc = (data) => ({ exists: true, id: 'uid-1', data: () => data });

beforeEach(() => {
  vi.clearAllMocks();
  verifyIdToken.mockResolvedValue({ uid: 'uid-1' });
  userGet.mockResolvedValue(userDoc({ name: 'Arun', isAdmin: false }));
});

describe('requireAuth — 401 cases', () => {
  it.each([
    ['no Authorization header', undefined],
    ['empty header', ''],
    ['no Bearer scheme', 'abc123'],
    ['wrong scheme', 'Basic abc123'],
    ['Bearer with no token', 'Bearer '],
    ['Bearer with only whitespace', 'Bearer    '],
  ])('returns 401 for %s', async (_label, header) => {
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockReq(header), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  it('never calls Firebase when the header is malformed', async () => {
    await requireAuth(mockReq('Basic xyz'), mockRes(), vi.fn());

    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('returns 401 when Firebase rejects the token', async () => {
    verifyIdToken.mockRejectedValue(new Error('Decoding Firebase ID token failed'));
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockReq('Bearer bad-token'), res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.reason).toBe('invalid token');
    expect(next).not.toHaveBeenCalled();
  });

  it('distinguishes an expired token so the client can refresh', async () => {
    const err = new Error('expired');
    err.code = 'auth/id-token-expired';
    verifyIdToken.mockRejectedValue(err);
    const res = mockRes();

    await requireAuth(mockReq('Bearer stale'), res, vi.fn());

    expect(res.statusCode).toBe(401);
    expect(res.body.reason).toBe('expired token');
  });

  it('returns 401 if the decoded token carries no uid', async () => {
    verifyIdToken.mockResolvedValue({});
    const res = mockRes();

    await requireAuth(mockReq('Bearer weird'), res, vi.fn());

    expect(res.statusCode).toBe(401);
  });

  it('accepts a lower-case bearer scheme', async () => {
    const next = vi.fn();
    const req = mockReq('bearer good-token');

    await requireAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.uid).toBe('uid-1');
  });

  it('passes the extracted token to Firebase, not the whole header', async () => {
    await requireAuth(mockReq('Bearer the-token'), mockRes(), vi.fn());

    expect(verifyIdToken).toHaveBeenCalledWith('the-token');
  });
});

describe('requireAuth — 403 when there is no user record', () => {
  it('returns 403 for a valid token with no user document', async () => {
    userGet.mockResolvedValue({ exists: false });
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockReq('Bearer good'), res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('Forbidden');
    expect(next).not.toHaveBeenCalled();
  });

  it('does not attach a uid when the record is missing', async () => {
    userGet.mockResolvedValue({ exists: false });
    const req = mockReq('Bearer good');

    await requireAuth(req, mockRes(), vi.fn());

    expect(req.uid).toBeUndefined();
    expect(req.user).toBeUndefined();
  });
});

describe('requireAuth — success', () => {
  it('attaches uid and the user record, then continues', async () => {
    const req = mockReq('Bearer good');
    const next = vi.fn();

    await requireAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.uid).toBe('uid-1');
    expect(req.user).toEqual({ id: 'uid-1', name: 'Arun', isAdmin: false });
  });

  it('looks the user up by the uid from the token', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'uid-9' });
    userGet.mockResolvedValue({ exists: true, id: 'uid-9', data: () => ({ name: 'X' }) });
    const req = mockReq('Bearer good');

    await requireAuth(req, mockRes(), vi.fn());

    expect(req.uid).toBe('uid-9');
  });

  it('exposes the decoded token for downstream use', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'uid-1', phone_number: '+919000000000' });
    const req = mockReq('Bearer good');

    await requireAuth(req, mockRes(), vi.fn());

    expect(req.token.phone_number).toBe('+919000000000');
  });
});

describe('requireAuth — a Firestore fault is a 500, never a 403', () => {
  it('forwards the error rather than claiming the user has no account', async () => {
    // Telling a real member "no user record" because a read timed out would send
    // them to sign up for an account they already have.
    const boom = new Error('14 UNAVAILABLE: connection failed');
    userGet.mockRejectedValue(boom);
    const res = mockRes();
    const next = vi.fn();

    await requireAuth(mockReq('Bearer good'), res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.statusCode).toBeNull();
  });
});

describe('requireAdmin', () => {
  it('continues for an admin', () => {
    const req = { user: { id: 'uid-1', isAdmin: true } };
    const next = vi.fn();

    requireAdmin(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it('returns 403 for a non-admin', () => {
    const res = mockRes();
    const next = vi.fn();

    requireAdmin({ user: { id: 'uid-1', isAdmin: false } }, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body.reason).toBe('admin only');
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['isAdmin absent', {}],
    ['isAdmin truthy but not true', { isAdmin: 'yes' }],
    ['isAdmin 1', { isAdmin: 1 }],
    ['isAdmin null', { isAdmin: null }],
  ])('returns 403 when %s — strict true only', (_label, user) => {
    const res = mockRes();

    requireAdmin({ user: { id: 'uid-1', ...user } }, res, vi.fn());

    expect(res.statusCode).toBe(403);
  });

  it('surfaces a wiring bug as a 500, not a silent 403', () => {
    // Reaching requireAdmin without requireAuth means the route is misconfigured.
    // A 403 would look like a working permission check and hide it.
    const res = mockRes();
    const next = vi.fn();

    requireAdmin({}, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(next.mock.calls[0][0].message).toMatch(/without requireAuth/);
    expect(res.statusCode).toBeNull();
  });
});
