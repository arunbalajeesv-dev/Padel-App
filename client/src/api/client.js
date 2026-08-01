/**
 * The single path from this app to the Express API.
 *
 * Nothing else in the client calls `fetch`. Every request goes through here so
 * that the bearer token, the error shape and the base URL are decided in exactly
 * one place.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS FETCHED FRESH ON EVERY REQUEST. NEVER CACHED.
 *
 * Firebase ID tokens expire after about an hour. The SDK refreshes them for us,
 * but ONLY if we ask it for the token each time — `getIdToken()` returns the
 * cached token when valid and transparently refreshes it when not.
 *
 * Caching the string ourselves would mean every session breaks exactly one hour
 * in, with a 401 that looks like "you were logged out" and is really "we held a
 * stale token". Do not add a token cache here, and do not pass tokens around as
 * arguments — ask the SDK.
 * ---------------------------------------------------------------------------
 */
import { API_BASE_URL } from '../config/env.js';
import { ApiError } from './ApiError.js';

/**
 * How the client obtains the current ID token. Injected rather than imported so
 * this module has no hard dependency on Firebase — which also makes it testable
 * without booting the SDK.
 *
 * @type {null | (() => Promise<string|null>)}
 */
let tokenProvider = null;

/** Wire the client to Firebase auth. Called once, at app start. */
export function setTokenProvider(provider) {
  tokenProvider = provider;
}

async function authHeader() {
  if (!tokenProvider) return {};
  // Fresh every time — see the note above.
  const token = await tokenProvider();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function buildUrl(path, query) {
  const url = new URL(path, API_BASE_URL);
  for (const [key, value] of Object.entries(query ?? {})) {
    // Skip absent filters entirely rather than sending `?area=undefined`.
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Perform a request.
 *
 * @param {string} path e.g. '/users/me'
 * @param {{method?: string, body?: object|FormData, query?: object, auth?: boolean}} options
 *   `auth: false` skips the bearer header, for the genuinely public routes:
 *   health checks and the pre-phone-auth signup gate, where the caller has no
 *   token yet by definition.
 *   A `FormData` body (photo upload) is sent as-is, with no `Content-Type` set
 *   — the browser fills in `multipart/form-data` plus the boundary itself;
 *   setting it manually strips that boundary and the server cannot parse it.
 * @returns {Promise<any>} parsed JSON, or null for 204.
 * @throws {ApiError} on any non-2xx response.
 */
export async function request(path, { method = 'GET', body, query, auth = true } = {}) {
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers = { ...(auth ? await authHeader() : {}) };
  if (body !== undefined && !isFormData) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      ...(body !== undefined ? { body: isFormData ? body : JSON.stringify(body) } : {}),
    });
  } catch (cause) {
    // Network-level failure: no response at all. Status 0 marks "never reached
    // the server", which a screen should word as connectivity, not rejection.
    const err = new ApiError(0, { reason: 'Could not reach the server.' }, path);
    err.cause = cause;
    throw err;
  }

  if (response.status === 204) return null;

  // Parse defensively: an error page or a proxy can return HTML, and a JSON
  // parse failure must not mask the status the caller needs to branch on.
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) throw new ApiError(response.status, payload, path);

  return payload;
}
