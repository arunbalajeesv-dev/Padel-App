import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import { makeFirestore } from '../fixtures/fakeFirestore.js';

const verifyIdToken = vi.fn();
let db;

vi.mock('../../src/config/firebase.js', () => ({
  getAuth: () => ({ verifyIdToken }),
  getFirestore: () => db,
}));

const { createApp } = await import('../../src/app.js');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

let _server;
async function sharedServer() {
  if (!_server) _server = await listen(createApp());
  return _server;
}
afterAll(() => {
  _server?.closeAllConnections?.();
  _server?.close();
});

async function call(method, path, body) {
  const server = await sharedServer();
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const code = (over = {}) => ({
  code: 'LOBSTER', phase: 'soft-launch', active: true,
  createdAt: '2026-08-01T00:00:00.000Z', ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db = makeFirestore({});
});

/**
 * These routes exist so a newcomer without a code is turned away BEFORE an
 * SMS is sent. They are public by necessity — the caller has no token yet.
 * The real enforcement stays on POST /users; see routes/signupGate.js.
 */
describe('GET /signup/gate — is a code needed right now?', () => {
  it('reports the gate OPEN when no codes exist', async () => {
    const { status, body } = await call('GET', '/signup/gate');

    expect(status).toBe(200);
    expect(body.inviteRequired).toBe(false);
  });

  it('reports the gate CLOSED once a code is active', async () => {
    db = makeFirestore({ 'inviteCodes/LOBSTER': code() });

    const { body } = await call('GET', '/signup/gate');
    expect(body.inviteRequired).toBe(true);
  });

  it('reports OPEN when every code is deactivated — how a soft launch ends', async () => {
    db = makeFirestore({ 'inviteCodes/LOBSTER': code({ active: false }) });

    const { body } = await call('GET', '/signup/gate');
    expect(body.inviteRequired).toBe(false);
  });

  it('needs no token — it runs before phone auth by design', async () => {
    const { status } = await call('GET', '/signup/gate');
    expect(status).not.toBe(401);
  });
});

describe('POST /signup/gate — check one code', () => {
  it('accepts a valid active code, case-insensitively', async () => {
    db = makeFirestore({ 'inviteCodes/LOBSTER': code() });

    const { status, body } = await call('POST', '/signup/gate', { code: 'lobster' });

    expect(status).toBe(200);
    expect(body.valid).toBe(true);
  });

  it('403s an unknown code', async () => {
    db = makeFirestore({ 'inviteCodes/LOBSTER': code() });

    const { status } = await call('POST', '/signup/gate', { code: 'NOPE' });
    expect(status).toBe(403);
  });

  it('403s a deactivated code', async () => {
    db = makeFirestore({
      'inviteCodes/LOBSTER': code(),
      'inviteCodes/OLD': code({ code: 'OLD', active: false }),
    });

    const { status } = await call('POST', '/signup/gate', { code: 'OLD' });
    expect(status).toBe(403);
  });

  it('400s a missing code', async () => {
    const { status } = await call('POST', '/signup/gate', {});
    expect(status).toBe(400);
  });

  it('never reveals which codes exist — only yes or no', async () => {
    db = makeFirestore({ 'inviteCodes/LOBSTER': code() });

    const { body } = await call('POST', '/signup/gate', { code: 'LOBSTER' });

    // No phase, no createdAt, no list of codes.
    expect(Object.keys(body)).toEqual(['valid']);
  });

  it('accepts anything while the gate is open — nothing is being withheld', async () => {
    const { status } = await call('POST', '/signup/gate', { code: 'ANYTHING' });
    expect(status).toBe(200);
  });
});
