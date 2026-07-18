/**
 * Courts data layer.
 *
 * The courts collection is an anti-abuse control, not a convenience: a match
 * requires that the court exists here. See CLAUDE.md > Anti-Abuse Rules.
 */
import { getFirestore } from '../config/firebase.js';

export const COURTS_COLLECTION = 'courts';

/** Sorts above any ordinary character — the upper bound of a prefix range. */
const HIGH_SENTINEL = '';

export const CREATABLE_FIELDS = Object.freeze(['name', 'address', 'area', 'isPartner']);

export function validateCourt(body) {
  const rejected = Object.keys(body ?? {}).filter((k) => !CREATABLE_FIELDS.includes(k));
  const errors = [];
  const input = body ?? {};

  if (typeof input.name !== 'string' || input.name.trim().length < 2) {
    errors.push('name must be a string of at least 2 characters.');
  }
  if (typeof input.area !== 'string' || input.area.trim().length === 0) {
    errors.push('area is required.');
  }
  if (Object.hasOwn(input, 'address') && input.address !== null && typeof input.address !== 'string') {
    errors.push('address must be a string or null.');
  }
  if (Object.hasOwn(input, 'isPartner') && typeof input.isPartner !== 'boolean') {
    errors.push('isPartner must be a boolean.');
  }

  return { rejected, errors };
}

/** Courts carry no private fields, but the shape is still an allowlist. */
export function toCourtView(court) {
  return {
    id: court.id,
    name: court.name,
    address: court.address ?? null,
    area: court.area,
    isPartner: court.isPartner === true,
  };
}

export async function findById(id) {
  const snap = await getFirestore().collection(COURTS_COLLECTION).doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * List courts, optionally filtered by area and/or name prefix.
 *
 * Firestore cannot range-filter on `name` while equality-filtering on `area`
 * without a composite index, so the area filter is applied in the query and the
 * search prefix narrows it. With ~a dozen courts this is not worth an index.
 */
export async function listCourts({ area, search, limit = 100 } = {}) {
  let q = getFirestore().collection(COURTS_COLLECTION);

  if (area) q = q.where('area', '==', area);

  const term = String(search ?? '').trim();
  if (term && !area) {
    q = q.orderBy('name').startAt(term).endAt(term + HIGH_SENTINEL);
  } else {
    q = q.orderBy('name');
  }

  const snap = await q.limit(limit).get();
  let courts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // When both filters are present the prefix is applied here rather than adding
  // a composite index for a collection this small.
  if (term && area) {
    courts = courts.filter((c) => String(c.name ?? '').startsWith(term));
  }

  return courts;
}

export async function createCourt(input) {
  const doc = {
    name: input.name,
    address: input.address ?? null,
    area: input.area,
    isPartner: input.isPartner === true,
    createdAt: new Date().toISOString(),
  };

  const ref = await getFirestore().collection(COURTS_COLLECTION).add(doc);
  return { id: ref.id, ...doc };
}
