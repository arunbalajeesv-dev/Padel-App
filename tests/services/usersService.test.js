import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/firebase.js', () => ({
  getFirestore: vi.fn(),
  getAuth: vi.fn(),
}));

const {
  toSelfView,
  toPublicView,
  validateCreate,
  validatePatch,
  CREATABLE_FIELDS,
  PATCHABLE_FIELDS,
  ADMIN_PATCHABLE_FIELDS,
} = await import('../../src/services/usersService.js');

const CONFIG = {
  defaultRating: 1500,
  defaultRd: 350,
  defaultVolatility: 0.06,
  displayScale: { ratingAtZero: 1000, ratingAtMax: 2500, maxUnits: 7 },
};

const USER = {
  id: 'uid-1',
  phone: '+919000000000',
  name: 'Arun',
  photoUrl: null,
  gender: 'M',
  area: 'Nungambakkam',
  rating: { value: 1714.3, rd: 62, sigma: 0.0601 },
  status: 'established',
  gamesPlayed: 24,
  isAnchor: false,
  isAdmin: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActiveAt: '2026-07-01T00:00:00.000Z',
};

/** The rule from CLAUDE.md, as a test: rating math is never exposed. */
// `value` is the stored rating scalar; `mu`/`phi` are internal Glicko names that
// never touch storage but are guarded anyway, so a regression that dumped engine
// internals onto a view would fail here.
const FORBIDDEN = ['value', 'mu', 'phi', 'sigma', 'rd', 'trustScore', 'rating', 'isAdmin'];

function assertNoLeak(payload) {
  const json = JSON.stringify(payload);
  for (const key of FORBIDDEN) {
    expect(json).not.toMatch(new RegExp(`"${key}"`));
  }
}

describe('toSelfView', () => {
  it('exposes ratingDisplay and status, never internal rating state', () => {
    const view = toSelfView(USER, CONFIG);

    expect(view.ratingDisplay).toBeCloseTo(3.33, 2);
    expect(view.status).toBe('established');
    assertNoLeak(view);
  });

  it('never leaks trustScore, even if one somehow appears on the document', () => {
    // trustScore is derived on read and never stored, so a real document has no
    // such field. Injecting one proves the view strips it regardless — it is
    // admin-internal and must never reach a player.
    expect(toSelfView({ ...USER, trustScore: 87 }, CONFIG).trustScore).toBeUndefined();
  });

  it('never leaks isAdmin', () => {
    expect(toSelfView(USER, CONFIG).isAdmin).toBeUndefined();
  });

  it('gives the owner their own phone', () => {
    expect(toSelfView(USER, CONFIG).phone).toBe('+919000000000');
  });

  it('is an allowlist — an unexpected field added later cannot leak', () => {
    const withSecret = { ...USER, internalNotes: 'flagged for review', mu: 1.23 };

    assertNoLeak(toSelfView(withSecret, CONFIG));
    expect(toSelfView(withSecret, CONFIG).internalNotes).toBeUndefined();
  });
});

describe('toPublicView', () => {
  it('exposes name, area and ratingDisplay only', () => {
    const view = toPublicView(USER, CONFIG);

    expect(Object.keys(view).sort()).toEqual(['area', 'id', 'name', 'ratingDisplay']);
    assertNoLeak(view);
  });

  it('never leaks another player\'s phone', () => {
    expect(toPublicView(USER, CONFIG).phone).toBeUndefined();
  });

  it('never leaks status, gamesPlayed or trustScore', () => {
    const view = toPublicView({ ...USER, trustScore: 87 }, CONFIG);

    expect(view.status).toBeUndefined();
    expect(view.gamesPlayed).toBeUndefined();
    expect(view.trustScore).toBeUndefined();
  });
});

describe('validateCreate', () => {
  it('accepts a well-formed profile', () => {
    const { rejected, errors } = validateCreate({
      name: 'Arun',
      gender: 'M',
      area: 'Velachery',
    });

    expect(rejected).toEqual([]);
    expect(errors).toEqual([]);
  });

  it.each(['rating', 'status', 'trustScore', 'isAdmin'])(
    'rejects a client attempt to set %s',
    (field) => {
      const { rejected } = validateCreate({ name: 'Arun', gender: 'M', [field]: 'x' });

      expect(rejected).toContain(field);
    },
  );

  it('rejects all privileged fields at once', () => {
    const { rejected } = validateCreate({
      name: 'Arun',
      gender: 'M',
      rating: { value: 2500 },
      status: 'established',
      trustScore: 100,
      isAdmin: true,
      gamesPlayed: 999,
      isAnchor: true,
      phone: '+910000000000',
    });

    expect(rejected).toEqual(
      expect.arrayContaining([
        'rating',
        'status',
        'trustScore',
        'isAdmin',
        'gamesPlayed',
        'isAnchor',
        'phone',
      ]),
    );
  });

  it('is an allowlist, so an unknown field is rejected too', () => {
    // The point of the allowlist: a privileged field added to the schema later
    // is rejected by default rather than until someone remembers to deny it.
    const { rejected } = validateCreate({ name: 'Arun', gender: 'M', futureSecret: 1 });

    expect(rejected).toContain('futureSecret');
  });

  it.each([
    ['missing name', { gender: 'M' }],
    ['one-character name', { name: 'A', gender: 'M' }],
    ['non-string name', { name: 42, gender: 'M' }],
    ['missing gender', { name: 'Arun' }],
    ['invalid gender', { name: 'Arun', gender: 'X' }],
  ])('rejects %s', (_label, body) => {
    expect(validateCreate(body).errors.length).toBeGreaterThan(0);
  });

  it('allows only the documented creatable fields', () => {
    expect(CREATABLE_FIELDS).toEqual(['name', 'photoUrl', 'gender', 'area']);
  });
});

describe('validatePatch', () => {
  it('accepts name, photoUrl and area', () => {
    const { rejected, errors } = validatePatch({
      name: 'Arun K',
      photoUrl: 'https://x/y.jpg',
      area: 'OMR',
    });

    expect(rejected).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('rejects gender for a self-patch — admin-only, not immutable', () => {
    expect(validatePatch({ gender: 'F' }).rejected).toContain('gender');
  });

  it('accepts gender for an admin patch', () => {
    // Safe because pairingType is frozen per match: changing gender cannot
    // rewrite matches already played. It moves the player to the correct
    // leaderboard, which is the desired outcome. See CLAUDE.md.
    const { rejected, errors } = validatePatch({ gender: 'F' }, { asAdmin: true });

    expect(rejected).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('still rejects privileged fields even for an admin patch', () => {
    const { rejected } = validatePatch(
      { rating: { value: 2500 }, status: 'established', trustScore: 100, isAdmin: true },
      { asAdmin: true },
    );

    expect(rejected).toEqual(
      expect.arrayContaining(['rating', 'status', 'trustScore', 'isAdmin']),
    );
  });

  it('admin-patchable is self-patchable plus gender, nothing more', () => {
    expect(ADMIN_PATCHABLE_FIELDS).toEqual(['name', 'photoUrl', 'area', 'gender']);
  });

  it.each(['rating', 'status', 'trustScore', 'isAdmin', 'gamesPlayed', 'phone'])(
    'rejects %s',
    (field) => {
      expect(validatePatch({ [field]: 'x' }).rejected).toContain(field);
    },
  );

  it('rejects an empty patch', () => {
    expect(validatePatch({}).errors).toContain('No fields to update.');
  });

  it('allows only the documented patchable fields', () => {
    expect(PATCHABLE_FIELDS).toEqual(['name', 'photoUrl', 'area']);
  });
});
