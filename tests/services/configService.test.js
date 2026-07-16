import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const get = vi.fn();

vi.mock('../../src/config/firebase.js', () => ({
  getFirestore: () => ({ collection: () => ({ doc: () => ({ get }) }) }),
  getAuth: vi.fn(),
}));

const { getConfig, getConfigVersion, invalidateConfigCache } = await import(
  '../../src/services/configService.js'
);

const VALID = {
  version: 1,
  tau: 0.5,
  defaultRating: 1500,
  defaultRd: 350,
  defaultVolatility: 0.06,
  lambdaSame: 0.12,
  lambdaMixed: 0.2,
  gapScaleD: 1.15,
  synergy: {
    same: { repeat: 0.1, firstTime: 0.17 },
    mixed: { repeat: 0.17, firstTime: 0.23 },
  },
  formatSingleSet: 0.65,
  formatThreeSet: 1.0,
  marginBase: 0.8,
  marginCoefficient: 0.4,
  repeatMultipliers: [1.0, 0.7, 0.4, 0.2],
  repeatWindowDays: 7,
  maxDeltaPerMatch: 150,
  weeklyGainCap: 200,
  rdThresholds: { placement: 200, provisional: 100 },
};

function snapshot(data) {
  return { exists: true, data: () => structuredClone(data) };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateConfigCache();
  get.mockResolvedValue(snapshot(VALID));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getConfig', () => {
  it('returns the config document', async () => {
    await expect(getConfig()).resolves.toMatchObject({ version: 1, tau: 0.5 });
  });

  it('throws a pointed error when the document is absent', async () => {
    get.mockResolvedValue({ exists: false });

    await expect(getConfig()).rejects.toThrow(/not found at config\/rating/);
    await expect(getConfig()).rejects.toThrow(/seedConfig/);
  });

  it('caches across calls rather than reading Firestore each time', async () => {
    await getConfig();
    await getConfig();
    await getConfig();

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the TTL expires', async () => {
    vi.useFakeTimers();

    await getConfig();
    vi.advanceTimersByTime(61_000);
    await getConfig();

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent misses into a single read', async () => {
    // Four players' deltas for one match must not cost four reads.
    await Promise.all([getConfig(), getConfig(), getConfig(), getConfig()]);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache when forced', async () => {
    await getConfig();
    await getConfig({ force: true });

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed read', async () => {
    get.mockRejectedValueOnce(new Error('UNAVAILABLE'));
    await expect(getConfig()).rejects.toThrow(/UNAVAILABLE/);

    get.mockResolvedValue(snapshot(VALID));
    await expect(getConfig()).resolves.toMatchObject({ version: 1 });
  });

  it('is frozen, including nested values', async () => {
    const config = await getConfig();

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.synergy.mixed)).toBe(true);
    expect(() => {
      config.synergy.mixed.firstTime = 99;
    }).toThrow();
  });
});

describe('config validation', () => {
  it('rejects a missing top-level constant', async () => {
    const { weeklyGainCap, ...rest } = VALID;
    get.mockResolvedValue(snapshot(rest));

    await expect(getConfig()).rejects.toThrow(/weeklyGainCap must be a finite number/);
  });

  it('rejects a missing nested constant', async () => {
    const broken = structuredClone(VALID);
    delete broken.rdThresholds.placement;
    get.mockResolvedValue(snapshot(broken));

    await expect(getConfig()).rejects.toThrow(
      /rdThresholds\.placement must be a finite number/,
    );
  });

  it('rejects a non-numeric constant', async () => {
    const broken = structuredClone(VALID);
    broken.gapScaleD = '1.15';
    get.mockResolvedValue(snapshot(broken));

    await expect(getConfig()).rejects.toThrow(/gapScaleD must be a finite number/);
  });

  it('rejects NaN, which would silently poison every delta', async () => {
    const broken = structuredClone(VALID);
    broken.lambdaMixed = NaN;
    get.mockResolvedValue(snapshot(broken));

    await expect(getConfig()).rejects.toThrow(/lambdaMixed must be a finite number/);
  });

  it('rejects an empty repeatMultipliers array', async () => {
    const broken = structuredClone(VALID);
    broken.repeatMultipliers = [];
    get.mockResolvedValue(snapshot(broken));

    await expect(getConfig()).rejects.toThrow(/repeatMultipliers must be a non-empty array/);
  });

  it('reports every problem at once, not just the first', async () => {
    const broken = structuredClone(VALID);
    delete broken.tau;
    delete broken.maxDeltaPerMatch;
    get.mockResolvedValue(snapshot(broken));

    await expect(getConfig()).rejects.toThrow(/tau[\s\S]*maxDeltaPerMatch/);
  });

  it('never substitutes a default for a missing constant', async () => {
    const broken = structuredClone(VALID);
    delete broken.defaultRating;
    get.mockResolvedValue(snapshot(broken));

    // A silent 1500 here would hardcode a constant and mis-stamp history.
    await expect(getConfig()).rejects.toThrow(/defaultRating/);
  });
});

describe('getConfigVersion', () => {
  it('returns the version stamp', async () => {
    await expect(getConfigVersion()).resolves.toBe(1);
  });

  it('shares the cache with getConfig', async () => {
    await getConfig();
    await getConfigVersion();

    expect(get).toHaveBeenCalledTimes(1);
  });
});
