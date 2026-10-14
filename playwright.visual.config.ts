import { defineConfig, devices } from '@playwright/test';

// Isolated port: do not stop an existing developer preview to capture evidence.
export default defineConfig({
  testDir: './tests/e2e-archive',
  testMatch: '**/visual-replica.spec.ts',
  workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4180', timezoneId: 'Asia/Shanghai', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 4180 --strictPort',
    url: 'http://127.0.0.1:4180', reuseExistingServer: false,
  },
});
