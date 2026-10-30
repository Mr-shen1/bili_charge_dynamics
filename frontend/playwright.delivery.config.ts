import { defineConfig, devices } from '@playwright/test';
import './playwright.loopback-proxy';

/**
 * 10：三个真实进程（API＋独立采集＋独立通知）到生产前端装配的完整链。
 *
 * 用例自己拉起 `backend.tests.delivery_fixture` 的 API/collector 与生产
 * `backend.bili_monitor.notifier`，共享本次运行独占的临时 SQLite；通知进程把消息发到
 * 用例内的本机 HTTP 接收端，测试只打开消息里的实际链接。页面是生产装配（默认真实 API），
 * `/api` 由 vite 代理到实际后端，不访问真实上游、真实群或 OSS。
 * 端口与 test:e2e（4318/4319/4320）、manage（4177/4324）、location（4178/4325）、
 * notification（4179/4326）分开，避免并发跑测冲突。
 */
const apiPort = Number(process.env.DELIVERY_E2E_API_PORT ?? 4181);
const webPort = Number(process.env.DELIVERY_E2E_WEB_PORT ?? 4328);

export default defineConfig({
  testDir: './tests/e2e-delivery',
  fullyParallel: false,
  workers: 1,
  // 三个真实进程启动、真实归档与投递需要比普通页面用例更长的预算（beforeAll 内另设钩子超时）。
  timeout: 120_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `pnpm dev --host 127.0.0.1 --port ${webPort} --strictPort`,
      env: { API_SERVER: `http://127.0.0.1:${apiPort}` },
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
    },
  ],
});
