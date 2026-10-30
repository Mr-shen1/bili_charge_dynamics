import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import './playwright.loopback-proxy';

/**
 * 票据 14 视觉基准：生产构建（dist/）+ 实际管理 API + 受控归档 HTTP 替身。
 * 截图与布局审计都跑同一份候选产物；管理读取使用 backend/tests/live_app 的虚构上游，
 * 数据库是本次运行独占的临时 SQLite，不触发真实上游采集。
 * 先 `pnpm build`（由 `pnpm visual:baseline` 保证），再运行本配置。
 */
const apiPort = 4178;
const webPort = 4325;
const database = join(mkdtempSync(join(tmpdir(), 'bili-visual-e2e-')), 'monitor.sqlite');

// 视觉基准只访问回环地址：NO_PROXY 兜底由 playwright.loopback-proxy 统一处理。

export default defineConfig({
  testDir: './tests/e2e-visual',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${webPort}`,
    deviceScaleFactor: 1,
    timezoneId: 'Asia/Shanghai',
    locale: 'zh-CN',
    colorScheme: 'light',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `uv run --no-sync python -m uvicorn backend.tests.live_app:create_app --factory --host 127.0.0.1 --port ${apiPort}`,
      // 后端夹具与 uv 环境在仓库根，前端配置位于 frontend/。
      cwd: '..',
      env: { BILI_DATABASE_PATH: database },
      url: `http://127.0.0.1:${apiPort}/api/manage/ups`,
      reuseExistingServer: false,
    },
    {
      command: `pnpm preview --host 127.0.0.1 --port ${webPort} --strictPort`,
      env: { API_SERVER: `http://127.0.0.1:${apiPort}` },
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});
