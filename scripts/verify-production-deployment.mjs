import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { verifyProductionDelivery } from './verify-production-delivery.mjs';
import { publishAndVerifyEntryUpdate } from './verify-entry-update.mjs';

export const deliverySecret = 'FAKE_DEPLOYMENT_SECRET_31_NEVER_REAL';
export const deliveryEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('BILI_') && !key.startsWith('DEPLOYMENT_FIXTURE_')
    && !key.startsWith('UVICORN_') && key !== 'WEB_CONCURRENCY')),
  BILI_DEPLOYMENT_SECRET: deliverySecret,
  NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
};

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const signal = name => {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, name);
  };
  signal('SIGTERM');
  const timeout = setTimeout(() => signal('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timeout); }
}

async function waitFor(check, child, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(child.exitCode, null, `${label} process exited`);
    if (await check()) return;
    await delay(100);
  }
  assert.fail(`Timed out: ${label}`);
}

export async function verifyProductionDeployment({
  repo, workspace, current, productionBuild, buildSource, apiPort, baseURL, nginxLogs,
}) {
  const database = join(workspace, 'deployment.sqlite');
  let logs = '';
  const start = args => {
    const child = spawn('uv', ['run', '--no-sync', ...args], {
      cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...deliveryEnv, BILI_DATABASE_PATH: database },
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += String(chunk); });
    // 将启动错误转换成受控失败，避免未处理的 error 事件。
    child.on('error', () => { logs += 'Test process could not start'; });
    return child;
  };
  const apiURL = `http://127.0.0.1:${apiPort}`;
  const request = async (path, options) => fetch(`${apiURL}${path}`, {
    ...options, signal: AbortSignal.timeout(2000),
  });
  const write = async (method, path, body, expected) => {
    const response = await request(path, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, expected, `${method} ${path}`);
  };
  let api;
  let collector;
  let browser;
  try {
    api = start(['uvicorn', 'backend.tests.deployment_fixture:create_app', '--factory', '--host', '127.0.0.1', '--port', String(apiPort)]);
    await waitFor(async () => {
      try { return (await request('/api/manage/ups')).ok; } catch { return false; }
    }, api, 'fixture API');
    await write('POST', '/api/manage/ups', { uid: '202' }, 201);
    await write('PATCH', '/api/manage/ups/202/monitor', { enabled: true, mode: 'specified', recent_n: 10 }, 200);
    await write('POST', '/api/manage/ups/202/targets', { id: '91001' }, 201);
    collector = start(['python', '-m', 'backend.tests.deployment_fixture', '--database', database]);
    await waitFor(async () => {
      const response = await request('/api/archive/dynamics/91001');
      if (!response.ok) return false;
      const archive = await response.json();
      return archive.media?.some(item => item.status === 'success');
    }, collector, 'fixture archive and simulated upload');
    await symlink(productionBuild, join(workspace, 'production-next'));
    await rename(join(workspace, 'production-next'), current);
    await verifyProductionDelivery(baseURL, productionBuild, deliverySecret);

    // 在生产构建上也演练更新，而不只依赖历史 mock 的发布证据。
    const result = spawnSync('pnpm', ['build'], { cwd: buildSource, env: deliveryEnv, stdio: 'inherit' });
    assert.equal(result.status, 0, 'Production update build failed');
    const updated = join(buildSource, 'dist');
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`${baseURL}/dynamics/91001`);
    await page.getByText('部署隔离正文', { exact: false }).first().waitFor();
    await publishAndVerifyEntryUpdate({
      baseURL, workspace, current, previousBuild: productionBuild, nextBuild: updated, page,
    });
    await page.getByText('部署隔离正文', { exact: false }).first().waitFor();
    await stop(collector);
    await stop(api);
    // 上游进程不可达必须保留 502；诊断不得携带请求中的虚构秘密。
    const unavailable = await fetch(`${baseURL}/api/archive/ups?token=${deliverySecret}`);
    assert.equal(unavailable.status, 502);
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    assert(!(await unavailable.text()).includes('<div id="root">'));
    await fetch(`${baseURL}/assets/missing.js?token=${deliverySecret}`);
    await delay(100);
    assert(!(logs + nginxLogs()).includes(deliverySecret), 'Process diagnostics leaked the fixture secret');
    console.log('PASS: real API + collector share SQLite; production build update, API unavailable 502 and diagnostic secret scan');
  } finally {
    await browser?.close();
    await stop(collector);
    await stop(api);
  }
}
