import 'dotenv/config';
import { initializeApp, getApps, getApp, cert } from 'firebase-admin/app';
import { getFirestore as firestoreFor } from 'firebase-admin/firestore';
import { getAuth as authFor } from 'firebase-admin/auth';

const REQUIRED_VARS = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
];

function readCredentials() {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Firebase is not configured. Missing env vars: ${missing.join(', ')}`,
    );
  }

  // dotenv expands \n inside quoted values, but Render's env var dashboard
  // stores the sequence literally. Normalise both to a real PEM.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');

  if (!privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error(
      'FIREBASE_PRIVATE_KEY is not a PEM block. Use the `private_key` field ' +
        'from the service account JSON, not `private_key_id`.',
    );
  }

  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey,
  };
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
