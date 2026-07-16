import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();

vi.mock('../../src/config/firebase.js', () => ({
  getFirestore: () => ({
    collection: () => ({ doc: () => ({ get }) }),
  }),
  getAuth: vi.fn(),
}));

const { createApp } = await import('../../src/app.js');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function request(path) {
  const server = await listen(createApp());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
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

describe('unknown routes', () => {
  it('returns a JSON 404', async () => {
    const { status, body } = await request('/nope');

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not Found' });
  });
});
