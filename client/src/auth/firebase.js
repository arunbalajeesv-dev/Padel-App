/**
 * Firebase browser SDK — Auth only.
 *
 * This app uses Firebase in the browser for ONE thing: phone OTP, which yields
 * an ID token. Everything else goes through the Express API.
 *
 * There is deliberately no Firestore client here. Reading Firestore directly
 * would bypass the rating engine, the anti-abuse rules and every request
 * allowlist the API enforces. See client/CLAUDE.md.
 */
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

import { getFirebaseConfig } from '../config/env.js';

/** Lazily initialised so the shell boots without Firebase configured. */
export function firebaseApp() {
  return getApps().length ? getApp() : initializeApp(getFirebaseConfig());
}

export function auth() {
  return getAuth(firebaseApp());
}

/**
 * The current ID token, or null when signed out.
 *
 * Asks the SDK every time rather than caching: the SDK returns its cached token
 * while valid and refreshes transparently when it is not. This is the function
 * the API client is wired to.
 */
export async function currentIdToken() {
  const user = auth().currentUser;
  if (!user) return null;
  return user.getIdToken();
}
