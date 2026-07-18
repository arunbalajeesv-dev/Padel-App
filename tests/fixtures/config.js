/**
 * A complete, valid rating config mirroring config/rating v1.
 *
 * Shared because configService validates the WHOLE document: a partial fixture
 * fails validation rather than defaulting, which is the intended behaviour but
 * makes every route test need the full object.
 *
 * Keep in step with scripts/seedConfig.js.
 */
export const VALID_CONFIG = Object.freeze({
  version: 1,
  tau: 0.5,
  defaultRating: 1500,
  defaultRd: 350,
  defaultVolatility: 0.06,
  lambdaSame: 0.12,
  lambdaMixed: 0.12,
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
  maxDeltaPerMatch: 300,
  rdThresholds: { placement: 150, provisional: 100 },
  gamesPlayedFloors: { provisional: 8, established: 10 },
  displayScale: { ratingAtZero: 1000, ratingAtMax: 2500, maxUnits: 7 },
  weeklyGainAlertThreshold: 200,
  weeklyGainAlertWindowDays: 7,
  trustScorePriorWeight: 5,
  inactivityThresholdDays: 30,
});
