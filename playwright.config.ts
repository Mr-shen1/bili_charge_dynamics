import { defineConfig, devices } from '@playwright/test';

const preview = process.env.E2E_TARGET === 'preview';
const nginx = process.env.E2E_TARGET === 'nginx';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: preview || nginx ? '**/fault.spec.ts' : undefined,
  fullyParallel: true,
  use: { baseURL: 'http://127.0.0.1:4173', timezoneId: 'America/Los_Angeles', trace: 'retain-on-failure' },
  workers: 2,
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  // Nginx 由静态交付验证脚本管理，不以 Vite preview 代替。
  webServer: nginx ? undefined : [
    {
      command: `pnpm ${preview ? 'preview' : 'dev'} --host 127.0.0.1 --port 4173 --strictPort`,
      url: 'http://127.0.0.1:4173', reuseExistingServer: false,
    },
    ...(!preview ? [{
      command: 'pnpm dev:fault --host 127.0.0.1 --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174', reuseExistingServer: false,
    }] : []),
  ],
});
