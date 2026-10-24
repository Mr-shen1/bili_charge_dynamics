import { defineConfig, devices } from '@playwright/test';

const port = 4318;
const imagePort = 4319;
const preview = process.env.E2E_TARGET === 'preview';

// 默认 Linux Chromium；iPhone Safari 必须人工在真机执行，不能用这里的模拟代替。
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // 图片夹具服务器记录共享的请求与失败计数，串行执行避免相互污染。
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      command: 'node server/imageServer.mjs',
      url: `http://127.0.0.1:${imagePort}/__requests`,
      reuseExistingServer: false,
    },
    {
      // E2E_TARGET=preview 时跑生产构建产物，静态交付细节仍由后续票据验证。
      command: preview
        ? `pnpm build && pnpm preview --host 127.0.0.1 --port ${port} --strictPort`
        : `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
    },
  ],
});
