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
 * Every path here uses a SINGLE-field query so no composite index is required —
 * the directory is ~a dozen courts, so sorting and prefix-filtering in memory is
 * cheaper than maintaining an index.
 *
 * The subtlety: `where('area','==') .orderBy('name')` in one query is NOT single
 * field — it needs an (area, name) composite index and 500s without one. So when
 * an area is given, we filter by area equality alone (auto-indexed) and sort by
 * name in memory, rather than ordering in the query.
 */
export async function listCourts({ area, search, limit = 100 } = {}) {
  const col = getFirestore().collection(COURTS_COLLECTION);
  const term = String(search ?? '').trim();

  if (area) {
    // Equality on one field — served by the automatic index. Order and any
    // prefix match are applied in memory, deliberately avoiding a composite.
    const snap = await col.where('area', '==', area).limit(limit).get();
    let courts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (term) courts = courts.filter((c) => String(c.name ?? '').startsWith(term));
    courts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return courts;
  }

  // No area filter: order by name (single-field), with an optional prefix range.
  let q = col.orderBy('name');
  if (term) q = q.startAt(term).endAt(term + HIGH_SENTINEL);

  const snap = await q.limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
