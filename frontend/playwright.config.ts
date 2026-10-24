import { defineConfig, devices } from '@playwright/test';

const port = 4318;
const imagePort = 4319;
// 列表用例需要生产装配 + HTTP 传输替身；mock/fault 装配自带归档夹具，不能替换其读取。
const listPort = 4320;
const preview = process.env.E2E_TARGET === 'preview';
const mockBase = `http://127.0.0.1:${port}`;
const listBase = `http://127.0.0.1:${listPort}`;
// 列表与一级评论用例需要生产装配 + HTTP 传输替身；mock/fault 装配自带归档夹具。
const archiveSpecs = ['**/list.spec.ts', '**/comments.spec.ts'];
// 宽屏回复只在桌面项目跑：窄屏回复入口由票据 07 交付。
const desktopArchiveSpecs = [...archiveSpecs, '**/replies.spec.ts'];
// mock/fault 装配不覆试生产装配的回复用例（它自带夹具且无 HTTP 替身）。
const mockIgnore = [...archiveSpecs, '**/replies.spec.ts'];

// mock 装配 + 图片夹具；默认 Linux Chromium，iPhone Safari 必须人工在真机执行。
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  // 图片夹具服务器记录共享的请求与失败计数，串行执行避免相互污染。
  workers: 1,
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], baseURL: mockBase },
      testIgnore: mockIgnore,
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], baseURL: mockBase },
      testIgnore: mockIgnore,
    },
    {
      name: 'desktop-chromium-archive',
      use: { ...devices['Desktop Chrome'], baseURL: listBase },
      testMatch: desktopArchiveSpecs,
    },
    {
      name: 'mobile-chromium-archive',
      use: { ...devices['Pixel 7'], baseURL: listBase },
      testMatch: archiveSpecs,
    },
  ],
  webServer: [
    {
      command: 'node server/imageServer.mjs',
      url: `http://127.0.0.1:${imagePort}/__requests`,
      reuseExistingServer: false,
    },
    {
      // E2E_TARGET=preview 时跑 mock 装配的构建产物；静态交付细节仍由后续票据验证。
      command: preview
        ? `pnpm build:mock && pnpm preview:mock --host 127.0.0.1 --port ${port} --strictPort`
        : `pnpm dev:mock --host 127.0.0.1 --port ${port} --strictPort`,
      url: mockBase,
      reuseExistingServer: false,
    },
    {
      command: `pnpm dev --host 127.0.0.1 --port ${listPort} --strictPort`,
      url: listBase,
      reuseExistingServer: false,
    },
  ],
});
