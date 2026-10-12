import { defineConfig, devices } from '@playwright/test';

// 使用生产 Adapter、fixture HTTP 上游及测试专属真实 SQLite 文件。
export default defineConfig({
  testDir: './tests/e2e-archive',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4177',
    timezoneId: 'America/Los_Angeles',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev --mode manage-e2e --host 127.0.0.1 --port 4177 --strictPort',
    url: 'http://127.0.0.1:4177',
    reuseExistingServer: false,
  },
});
