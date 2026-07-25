/**
 * The field/claim that marks a player as disposable test data.
 *
 * Lives in its own side-effect-free module so the seed and delete scripts can
 * share it WITHOUT importing each other — importing a script module would run
 * its `main()`, and the deleter importing the seeder once triggered a seed.
 */
export const TEST_PLAYER_FLAG = 'isTestPlayer';
