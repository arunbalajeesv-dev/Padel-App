import { describe, it, expect, vi, beforeEach } from 'vitest';

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

async function request(path, headers = {}) {
  const server = await listen(createApp());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
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
