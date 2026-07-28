import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getFirestore as firestoreFor } from 'firebase-admin/firestore';
import { getAuth as authFor } from 'firebase-admin/auth';
import { getStorage as storageFor } from 'firebase-admin/storage';

/**
 * Service account credentials, from whichever source is configured.
 *
 * Three sources, tried in this order:
 *
 *   1. GOOGLE_APPLICATION_CREDENTIALS — a PATH to the service account JSON.
 *      The Google/Firebase standard, and the one to prefer in production. On
 *      Render this is a Secret File: the whole downloaded JSON is pasted in
 *      as-is and mounted at a path, so there is no key to reformat and no
 *      newline to mangle. Pasting a PEM into a dashboard text box is where this
 *      goes wrong, and a file sidesteps it entirely.
 *
 *   2. FIREBASE_SERVICE_ACCOUNT — the whole JSON in one variable. Useful where
 *      files cannot be mounted but a single blob can be set.
 *
 *   3. FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY —
 *      the original three-variable form. Kept so existing setups and local
 *      .env files keep working unchanged.
 *
 * Whichever is used, the PEM guard below runs. It is the reason a bad
 * deployment says exactly what is wrong instead of failing as "invalid token"
 * on every request an hour later.
 */

/** A private key may arrive with literal \n sequences instead of newlines. */
const normaliseKey = (key) => String(key).replace(/\\n/g, '\n');

/**
 * Validate and shape a credential set. Errors name their SOURCE, because
 * "which of the three did it even read?" is the first question when a deploy
 * fails.
 */
function validate({ projectId, clientEmail, privateKey }, source) {
  const missing = [];
  if (!projectId) missing.push('project_id');
  if (!clientEmail) missing.push('client_email');
  if (!privateKey) missing.push('private_key');

  if (missing.length > 0) {
    throw new Error(
      `Firebase credentials from ${source} are incomplete. Missing: ${missing.join(', ')}.`,
    );
  }

  const key = normaliseKey(privateKey);

  // The guard that catches the classic mistake: pasting `private_key_id` (a
  // short hex string) where `private_key` (a PEM block) belongs.
  if (!key.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error(
      `The private key from ${source} is not a PEM block. Use the \`private_key\` ` +
        'field from the service account JSON, not `private_key_id`.',
    );
  }

  return { projectId, clientEmail, privateKey: key };
}

/** Map a parsed service account JSON onto the shape cert() wants. */
function fromServiceAccountJson(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${source} does not contain valid JSON. Paste the service account file ` +
        'exactly as downloaded, with no edits.',
    );
  }

  return validate(
    {
      projectId: parsed.project_id,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    },
    source,
  );
}

/** 1. A path to the JSON file — Render Secret File, or a local file. */
function fromCredentialsFile() {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) return null;

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS is set to "${path}", but that file could ` +
        `not be read (${cause.code ?? cause.message}). On Render, check the ` +
        'Secret File name matches the path exactly — it is mounted under /etc/secrets/.',
    );
  }

  return fromServiceAccountJson(raw, `GOOGLE_APPLICATION_CREDENTIALS (${path})`);
}

/** 2. The whole JSON in one environment variable. */
function fromServiceAccountVar() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  return fromServiceAccountJson(raw, 'FIREBASE_SERVICE_ACCOUNT');
}

/** 3. The original three separate variables. */
function fromIndividualVars() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId && !clientEmail && !privateKey) return null;

  return validate({ projectId, clientEmail, privateKey }, 'FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY');
}

function readCredentials() {
  const credentials =
    fromCredentialsFile() ?? fromServiceAccountVar() ?? fromIndividualVars();

  if (!credentials) {
    throw new Error(
      'Firebase is not configured. Set one of:\n' +
        '  GOOGLE_APPLICATION_CREDENTIALS  — path to the service account JSON (preferred)\n' +
        '  FIREBASE_SERVICE_ACCOUNT        — the service account JSON itself\n' +
        '  FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY',
    );
  }

  return credentials;
}

/**
 * The Storage bucket name, e.g. `chennai-padel.firebasestorage.app`. Required
 * only by callers of `getStorage()` — a deployment that never uploads a photo
 * should not be forced to configure it, so this is read lazily rather than at
 * app-init time.
 */
function readStorageBucket() {
  const bucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error(
      'FIREBASE_STORAGE_BUCKET is not set. Copy the bucket name from the ' +
        'Firebase console (Storage > Files) or the client\'s ' +
        'VITE_FIREBASE_STORAGE_BUCKET — the two must match.',
    );
  }
  return bucket;
}

let app;

function getFirebaseApp() {
  if (app) return app;

  // Guard against double-init: `node --watch` re-imports this module while the
  // previous app is still registered on the process.
  app = getApps().length > 0
    ? getApp()
    : initializeApp({ credential: cert(readCredentials()) });

  return app;
}

export function getFirestore() {
  return firestoreFor(getFirebaseApp());
}

export function getAuth() {
  return authFor(getFirebaseApp());
}

/** The Storage bucket, for server-side reads/writes via the Admin SDK only. */
export function getStorage() {
  return storageFor(getFirebaseApp()).bucket(readStorageBucket());
}
