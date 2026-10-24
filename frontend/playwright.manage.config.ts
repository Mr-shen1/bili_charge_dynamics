import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * 管理页与实际 API 的隔离集成：后端使用 backend/tests/live_app 的虚构上游资料，
 * 数据库是本次运行独占的临时 SQLite（每次启动前清空），不触发真实上游采集或 OSS 上传。
 */
const apiPort = 4177;
const webPort = 4324;
// 不用 test-results：Playwright 每次运行会清空 outputDir，数据库会在启动前被删掉。
// 每次运行独占一个系统临时目录，互不污染；目录由操作系统清理。
const database = join(mkdtempSync(join(tmpdir(), 'bili-manage-e2e-')), 'monitor.sqlite');

export default defineConfig({
  testDir: './tests/e2e-manage',
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
      // 测试自有 API 进程：固定虚构资料 + 本次运行独占的 SQLite 文件。
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
