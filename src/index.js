import { createApp } from './app.js';
import { config } from './config/index.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Listening on port ${config.port} (${config.nodeEnv})`);
});
