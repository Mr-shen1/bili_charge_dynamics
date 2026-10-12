import { defineConfig, devices } from '@playwright/test';

// Separate from the read-only demo suite; the test owns the real API process and temporary DB.
export default defineConfig({
  testDir: './tests/e2e-manage',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4175',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev --mode manage-e2e --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
  },
});
