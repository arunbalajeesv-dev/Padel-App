/**
 * Invite codes — admin-managed access control for phased rollout.
 *
 * A code carries an `active` flag and a `phase` label (e.g. "alpha", "beta").
 * All management is admin-only; these are created, listed, toggled and deleted
 * from the admin surface. Whether signup consumes them is a separate concern —
 * this is the CRUD store.
 */
import { getFirestore } from '../config/firebase.js';

export const INVITE_CODES_COLLECTION = 'inviteCodes';

export const CREATABLE_FIELDS = Object.freeze(['code', 'phase', 'active']);
export const UPDATABLE_FIELDS = Object.freeze(['phase', 'active']);

const CODE_RE = /^[A-Z0-9-]{4,32}$/;

const rejectedFrom = (body, allowed) =>
  Object.keys(body ?? {}).filter((k) => !allowed.includes(k));

export function validateCreate(body) {
  const b = body ?? {};
  const errors = [];

  // The code itself is uppercased on write, so validate the normalised form.
  const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : null;
  if (!code || !CODE_RE.test(code)) {
    errors.push('code must be 4-32 chars of A-Z, 0-9 or hyphen.');
  }
  if (typeof b.phase !== 'string' || b.phase.trim().length === 0) {
    errors.push('phase is required.');
  }
  if (Object.hasOwn(b, 'active') && typeof b.active !== 'boolean') {
    errors.push('active must be a boolean.');
  }

  return { rejected: rejectedFrom(body, CREATABLE_FIELDS), errors };
}

export function validateUpdate(body) {
  const b = body ?? {};
  const errors = [];

  if (Object.hasOwn(b, 'phase') && (typeof b.phase !== 'string' || b.phase.trim().length === 0)) {
    errors.push('phase must be a non-empty string.');
  }
  if (Object.hasOwn(b, 'active') && typeof b.active !== 'boolean') {
    errors.push('active must be a boolean.');
  }
  if (!Object.hasOwn(b, 'phase') && !Object.hasOwn(b, 'active')) {
    errors.push('nothing to update — provide phase and/or active.');
  }

  return { rejected: rejectedFrom(body, UPDATABLE_FIELDS), errors };
}

export function toView(doc) {
  return {
    id: doc.id,
    code: doc.code,
    phase: doc.phase,
    active: doc.active === true,
    createdAt: doc.createdAt,
  };
}

export async function listCodes() {
  const snap = await getFirestore()
    .collection(INVITE_CODES_COLLECTION)
    .orderBy('createdAt', 'desc')
    .get();
  return snap.docs.map((d) => toView({ id: d.id, ...d.data() }));
}

/**
 * Create a code. The document id IS the normalised code, so a duplicate code
 * collides on create() rather than silently making a second row.
 */
export async function createCode(input) {
  const code = input.code.trim().toUpperCase();
  const doc = {
    code,
    phase: input.phase.trim(),
    active: input.active ?? true,
    createdAt: new Date().toISOString(),
  };

  await getFirestore().collection(INVITE_CODES_COLLECTION).doc(code).create(doc);
  return toView({ id: code, ...doc });
}

export async function updateCode(id, input) {
  const patch = {};
  for (const field of UPDATABLE_FIELDS) {
    if (Object.hasOwn(input, field)) {
      patch[field] = field === 'phase' ? input[field].trim() : input[field];
    }
  }

  const ref = getFirestore().collection(INVITE_CODES_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;

  await ref.update(patch);
  const updated = await ref.get();
  return toView({ id: updated.id, ...updated.data() });
}

export async function deleteCode(id) {
  const ref = getFirestore().collection(INVITE_CODES_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;

  await ref.delete();
  return true;
}
