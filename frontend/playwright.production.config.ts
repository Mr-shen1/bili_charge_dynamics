import { defineConfig, devices } from '@playwright/test';
import './playwright.loopback-proxy';

// 生产装配与 fault 装配的冒烟：验证普通构建不带自检入口，fault 装配与 mock 装配相互独立。
const productionPort = 4321;
const faultPort = 4322;

export default defineConfig({
  testDir: './tests/e2e-production',
  fullyParallel: false,
  workers: 1,
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'production',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${productionPort}` },
    },
    {
      name: 'fault',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${faultPort}` },
    },
  ],
  webServer: [
    {
      command: `pnpm dev --host 127.0.0.1 --port ${productionPort} --strictPort`,
      url: `http://127.0.0.1:${productionPort}`,
      reuseExistingServer: false,
    },
    {
      command: `pnpm dev:fault --host 127.0.0.1 --port ${faultPort} --strictPort`,
      url: `http://127.0.0.1:${faultPort}`,
      reuseExistingServer: false,
    },
  ],
});
