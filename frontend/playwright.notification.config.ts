import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import './playwright.loopback-proxy';

/**
 * 04：真实投递产物链接的浏览器验证。
 *
 * 后端是 backend/tests/live_app 的虚构上游 + 本次运行独占的临时 SQLite，通知投递由
 * `POST /api/test/notify-roots` 用真实 Dispatcher 打到进程内飞书替身，因此消息里的
 * 评论链接就是实际投递产物；页面仍是生产装配，请求经 vite 的 /api 代理到该进程。
 * 端口与 `test:e2e`（4320）、`test:e2e:location`（4325）、`test:e2e:manage` 分开，
 * 便于与并行票据同时运行；不访问真实上游、真实群或 OSS。
 */
const apiPort = 4179;
const webPort = 4326;
const database = join(mkdtempSync(join(tmpdir(), 'bili-notification-e2e-')), 'monitor.sqlite');

export default defineConfig({
  testDir: './tests/e2e-notification',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `uv run --no-sync python -m uvicorn backend.tests.live_app:create_app --factory --host 127.0.0.1 --port ${apiPort}`,
      cwd: '..',
      // 本站基址取浏览器可达的前端源：消息链接因此能直接打开，而不是拼一个别的主机。
      env: {
        BILI_DATABASE_PATH: database,
        BILI_TEST_NOTIFICATION_BASE: `http://127.0.0.1:${webPort}`,
      },
      url: `http://127.0.0.1:${apiPort}/api/manage/ups`,
      reuseExistingServer: false,
    },
    {
      command: `pnpm dev --host 127.0.0.1 --port ${webPort} --strictPort`,
      env: { API_SERVER: `http://127.0.0.1:${apiPort}` },
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});
