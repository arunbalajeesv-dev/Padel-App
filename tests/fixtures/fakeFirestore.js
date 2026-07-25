/**
 * A minimal in-memory Firestore stand-in.
 *
 * Only what this codebase actually calls: document get, collection queries with
 * ==, >=, <, in, array-contains, orderBy and limit, and transactions.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN vi.fn() MOCKS
 *
 * `runTransaction` here BUFFERS writes and commits them only if the callback
 * resolves. That is the one behaviour the confirmation pipeline depends on, and a
 * mock that records writes as they are issued cannot express it: a rollback test
 * against such a mock passes whether or not rollback works, because the writes it
 * asserts are absent were never real in the first place.
 * ---------------------------------------------------------------------------
 *
 * Documents are keyed by full path: 'users/me', 'users/me/ratingHistory/h1'.
 */

const segments = (path) => path.split('/');
const idOf = (path) => segments(path).pop();

const valueAt = (data, field) =>
  field.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), data);

function passes(data, { field, op, value }) {
  const actual = valueAt(data, field);

  switch (op) {
    case '==':
      return actual === value;
    case '>=':
      return actual >= value;
    case '<':
      return actual < value;
    case 'array-contains':
      return Array.isArray(actual) && actual.includes(value);
    case 'in':
      return value.includes(actual);
    default:
      throw new Error(`fakeFirestore: unsupported operator ${op}`);
  }
}

function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * @param {object} seed Path -> document data.
 * @param {{onWrite?: (write: object, index: number) => void}} [hooks] `onWrite`
 *   is called as each write is ISSUED and may throw, to simulate a failure part
 *   way through a transaction. Writes issued before it are already buffered,
 *   which is the point: it proves they are discarded rather than committed.
 */
export function makeFirestore(seed = {}, { onWrite } = {}) {
  const state = new Map(Object.entries(seed));
  let autoCounter = 0;

  const snapshotOf = (path) => {
    const data = state.get(path);
    return {
      exists: data !== undefined,
      id: idOf(path),
      ref: { path },
      data: () => data,
    };
  };

  const runQuery = ({ path, filters, limitN, orders }) => {
    const depth = segments(path).length + 1;

    let entries = [...state.entries()]
      .filter(([p]) => p.startsWith(`${path}/`) && segments(p).length === depth)
      .filter(([, data]) => filters.every((f) => passes(data, f)));

    for (const { field, direction } of [...orders].reverse()) {
      entries.sort(([, a], [, b]) => {
        const result = compare(valueAt(a, field), valueAt(b, field));
        return direction === 'desc' ? -result : result;
      });
    }

    let docs = entries.map(([p, data]) => ({
      id: idOf(p),
      ref: { path: p },
      data: () => data,
    }));

    if (limitN != null) docs = docs.slice(0, limitN);

    return { docs, size: docs.length, empty: docs.length === 0 };
  };

  function docRef(path) {
    return {
      __doc: true,
      path,
      id: idOf(path),
      get: async () => snapshotOf(path),
      collection: (name) => query(`${path}/${name}`),
      // Non-transactional writes. Transactional writes go through the tx object.
      set: async (data) => { state.set(path, data); },
      update: async (patch) => {
        if (!state.has(path)) {
          throw Object.assign(new Error(`No document to update: ${path}`), { code: 5 });
        }
        state.set(path, { ...state.get(path), ...patch });
      },
      create: async (data) => {
        if (state.has(path)) {
          throw Object.assign(new Error(`already exists: ${path}`), { code: 6 });
        }
        state.set(path, data);
      },
      delete: async () => { state.delete(path); },
    };
  }

  function query(path, filters = [], limitN = null, orders = []) {
    return {
      __query: true,
      path,
      filters,
      limitN,
      orders,
      where: (field, op, value) =>
        query(path, [...filters, { field, op, value }], limitN, orders),
      limit: (n) => query(path, filters, n, orders),
      orderBy: (field, direction = 'asc') =>
        query(path, filters, limitN, [...orders, { field, direction }]),
      get: async () => runQuery({ path, filters, limitN, orders }),
      // Firestore generates auto-ids client-side, which is what makes tx.create
      // usable inside a transaction.
      doc: (id) => docRef(`${path}/${id ?? `auto-${++autoCounter}`}`),
      add: async (data) => {
        const ref = docRef(`${path}/auto-${++autoCounter}`);
        await ref.set(data);
        return ref;
      },
    };
  }

  return {
    /** The raw store, for assertions. */
    state,

    collection: (name) => query(name),

    /** Batched multi-document read, mirroring firestore.getAll(...refs). */
    getAll: async (...refs) => refs.map((ref) => snapshotOf(ref.path)),

    async runTransaction(fn) {
      const writes = [];

      const issue = (write) => {
        onWrite?.(write, writes.length);
        writes.push(write);
      };

      const tx = {
        get: async (target) => (target.__query ? runQuery(target) : snapshotOf(target.path)),
        getAll: async (...refs) => refs.map((ref) => snapshotOf(ref.path)),
        update: (ref, patch) => issue({ kind: 'update', path: ref.path, patch }),
        create: (ref, data) => issue({ kind: 'create', path: ref.path, data }),
        set: (ref, data) => issue({ kind: 'set', path: ref.path, data }),
      };

      // Throwing here commits nothing — the writes array is simply discarded.
      const result = await fn(tx);

      for (const write of writes) {
        if (write.kind === 'update') {
          state.set(write.path, { ...state.get(write.path), ...write.patch });
        } else {
          state.set(write.path, write.data);
        }
      }

      return result;
    },
  };
}
