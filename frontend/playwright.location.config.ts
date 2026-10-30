import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import './playwright.loopback-proxy';

/**
 * 精确评论入口与实际归档 API 的隔离集成：后端使用 backend/tests/live_app 的虚构上游
 * （含仅测试用的 45 条虚构根评论夹具），数据库是本次运行独占的临时 SQLite；
 * 页面仍是生产装配，请求经 vite 的 /api 代理到该进程；不访问真实上游、不上传 OSS。
 * 与管理用例分开数据库和端口，避免跨文件顺序依赖。
 */
const apiPort = 4178;
const webPort = 4325;
// 不用 test-results：Playwright 每次运行会清空 outputDir，数据库会在启动前被删掉。
const database = join(mkdtempSync(join(tmpdir(), 'bili-location-e2e-')), 'monitor.sqlite');

export default defineConfig({
  testDir: './tests/e2e-location',
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
      // 测试自有 API 进程：固定虚构上游资料 + 本次运行独占的 SQLite 文件。
      command: `uv run --no-sync python -m uvicorn backend.tests.live_app:create_app --factory --host 127.0.0.1 --port ${apiPort}`,
      // 后端夹具与 uv 环境在仓库根，前端配置位于 frontend/。
      cwd: '..',
      env: { BILI_DATABASE_PATH: database },
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
