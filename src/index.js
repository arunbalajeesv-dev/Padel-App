import { createApp } from './app.js';
import { config } from './config/index.js';
import { startDecayCron } from './jobs/decayRatings.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Listening on port ${config.port} (${config.nodeEnv})`);
});

// In-process inactivity decay, only if DECAY_SCHEDULE is set. Without it, the job
// is expected to run as a standalone script under an external scheduler.
startDecayCron().catch((err) => {
  console.error('[decay] failed to schedule', err);
});
