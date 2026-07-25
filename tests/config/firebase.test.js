import { describe, it, expect, vi, beforeEach } from 'vitest';

const initializeApp = vi.fn(() => ({ name: 'mock-app' }));
const getApps = vi.fn(() => []);
const getApp = vi.fn(() => ({ name: 'existing-app' }));
const cert = vi.fn((creds) => ({ _creds: creds }));

vi.mock('firebase-admin/app', () => ({ initializeApp, getApps, getApp, cert }));
vi.mock('firebase-admin/firestore', () => ({ getFirestore: vi.fn(() => 'firestore') }));
vi.mock('firebase-admin/auth', () => ({ getAuth: vi.fn(() => 'auth') }));

const PEM = '-----BEGIN PRIVATE KEY-----\\nAAAA\\nBBBB\\n-----END PRIVATE KEY-----\\n';

async function loadFresh() {
  vi.resetModules();
  return import('../../src/config/firebase.js');
}

function setEnv({ projectId = 'p', clientEmail = 'e@x.com', privateKey = PEM } = {}) {
  vi.stubEnv('FIREBASE_PROJECT_ID', projectId);
  vi.stubEnv('FIREBASE_CLIENT_EMAIL', clientEmail);
  vi.stubEnv('FIREBASE_PRIVATE_KEY', privateKey);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  getApps.mockReturnValue([]);
});

describe('firebase config', () => {
  it('names the missing fields when the three-var source is incomplete', async () => {
    // privateKey present but the other two empty: the source is chosen (not all
    // three are absent), then reported as incomplete, naming what is missing.
    setEnv();
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    vi.stubEnv('FIREBASE_CLIENT_EMAIL', '');

    const { getFirestore } = await loadFresh();
    expect(() => getFirestore()).toThrow(/incomplete. Missing: project_id, client_email/);
  });

  it('lists all three sources when nothing at all is configured', async () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', '');
    vi.stubEnv('FIREBASE_CLIENT_EMAIL', '');
    vi.stubEnv('FIREBASE_PRIVATE_KEY', '');
    vi.stubEnv('FIREBASE_SERVICE_ACCOUNT', '');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');

    const { getFirestore } = await loadFresh();
    expect(() => getFirestore()).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/);
  });

  it('rejects a private_key_id pasted in place of the PEM', async () => {
    setEnv({ privateKey: '05cdf84ae0b9737dafb0d181de84628fb58de64f' });

    const { getFirestore } = await loadFresh();
    expect(() => getFirestore()).toThrow(/not a PEM block/);
  });

  it('converts escaped newlines to real ones before building the cert', async () => {
    setEnv();

    const { getFirestore } = await loadFresh();
    getFirestore();

    const key = cert.mock.calls[0][0].privateKey;
    expect(key).not.toContain('\\n');
    expect(key.split('\n')).toHaveLength(5);
    expect(key.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
  });

  it('accepts a key that already has real newlines', async () => {
    setEnv({ privateKey: PEM.replace(/\\n/g, '\n') });

    const { getFirestore } = await loadFresh();
    getFirestore();

    expect(cert.mock.calls[0][0].privateKey).not.toContain('\\n');
  });

  it('initialises once and caches across calls', async () => {
    setEnv();

    const { getFirestore, getAuth } = await loadFresh();
    getFirestore();
    getFirestore();
    getAuth();

    expect(initializeApp).toHaveBeenCalledTimes(1);
  });

  it('reuses an already-registered app instead of re-initialising', async () => {
    setEnv();
    getApps.mockReturnValue([{ name: 'existing-app' }]);

    const { getFirestore } = await loadFresh();
    getFirestore();

    expect(initializeApp).not.toHaveBeenCalled();
    expect(getApp).toHaveBeenCalled();
  });
});
