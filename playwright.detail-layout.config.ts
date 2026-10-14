import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-archive',
  testMatch: '**/detail-layout.spec.ts',
  workers: 1,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:4181', timezoneId: 'Asia/Shanghai', trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm dev --host 127.0.0.1 --port 4181 --strictPort',
    url: 'http://127.0.0.1:4181', reuseExistingServer: false,
  },
});
