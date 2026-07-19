import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  // Fail the BUILD, not the user's browser. Without this the app still refuses
  // to run unconfigured (see src/config/env.js), but the error would surface as
  // a blank page after deploy instead of a red CI job.
  if (command === 'build' && !env.VITE_API_BASE_URL) {
    throw new Error(
      'VITE_API_BASE_URL is not set. A production build must point at the ' +
        'Express API explicitly — see client/.env.example.',
    );
  }

  return { plugins: [react()] };
});
