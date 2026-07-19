/**
 * Environment configuration.
 *
 * Everything here is PUBLIC by design. The Firebase *web* config is meant to
 * ship to browsers — it identifies the project, it does not authorise anything.
 * Access is enforced by Firebase Auth and Firestore security rules, not by
 * hiding these values.
 *
 * The Admin SDK service account (FIREBASE_PRIVATE_KEY et al, in the BACKEND's
 * .env) must NEVER appear in this folder. That credential bypasses every
 * security rule in the project. See client/CLAUDE.md.
 *
 * Local and deployed builds differ ONLY by these values — no code branches on
 * environment.
 */

const isProd = import.meta.env.PROD;

function required(name) {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy client/.env.example to client/.env and fill it in.`,
    );
  }
  return value;
}

/**
 * Strict in a production build, sensible default in dev.
 *
 * The asymmetry is deliberate: `npm run dev` should work on a fresh clone with
 * no setup, but a deployed build must never quietly fall back to localhost and
 * appear to work while talking to nothing.
 */
function requiredInProd(name, devDefault) {
  const value = import.meta.env[name];
  if (value) return value;
  if (isProd) {
    throw new Error(`Missing ${name}. A production build must set it explicitly.`);
  }
  return devDefault;
}

/** Base URL of the Express API. */
export const API_BASE_URL = requiredInProd('VITE_API_BASE_URL', 'http://localhost:3000');

/**
 * Firebase web config — public, used to initialise the browser SDK.
 *
 * Resolved lazily rather than at import, so the app shell boots without Firebase
 * configured. Auth is not wired yet; when it is, this throws loudly at sign-in
 * if the values are missing, which is the moment they actually matter.
 */
export function getFirebaseConfig() {
  return {
    apiKey: required('VITE_FIREBASE_API_KEY'),
    authDomain: required('VITE_FIREBASE_AUTH_DOMAIN'),
    projectId: required('VITE_FIREBASE_PROJECT_ID'),
    storageBucket: required('VITE_FIREBASE_STORAGE_BUCKET'),
    messagingSenderId: required('VITE_FIREBASE_MESSAGING_SENDER_ID'),
    appId: required('VITE_FIREBASE_APP_ID'),
  };
}
