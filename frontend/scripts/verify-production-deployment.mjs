import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rename, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { verifyProductionDelivery } from './verify-production-delivery.mjs';
import { publishAndVerifyEntryUpdate, rollbackAndVerify } from './verify-entry-update.mjs';

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

async function waitFor(check, child, label, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    assert.equal(child.exitCode, null, `${label} process exited`);
    if (await check()) return;
    await delay(100);
  }
  assert.fail(`Timed out: ${label}`);
}

export async function verifyProductionDeployment({
  repo, workspace, current, productionBuild, buildSource, apiPort, baseURL, authBaseURL, nginxLogs,
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
    // collector 按固定节拍运行（生产默认 2.7 秒；测试环境由环境变量固定为 15 秒），首次检查与随后同步可能跨两个节拍；
    // 只放宽这一处到 60 秒，API 启动等其它等待保持原有上限。
    await waitFor(async () => {
      const response = await request('/api/archive/dynamics/91001');
      if (!response.ok) return false;
      const archive = await response.json();
      return archive.media?.some(item => item.status === 'success');
    }, collector, 'fixture archive and simulated upload', 600);
    await symlink(productionBuild, join(workspace, 'production-next'));
    await rename(join(workspace, 'production-next'), current);
    await verifyProductionDelivery(baseURL, productionBuild, deliverySecret, { authBaseURL });

    // 在生产构建上也演练更新与回退，而不只依赖历史 mock 的发布证据。
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

    // 回退只切前端产物：记录切换前的归档内容、数据库文件与 collector 进程，回退后必须原样保留。
    // 只比较稳定字段：collector 仍按固定节拍运行，检查时间可能自然推进。
    const stableArchive = archive => JSON.stringify({
      id: archive.id, text: archive.text,
      media: (archive.media ?? []).map(item => [item.id, item.url]),
    });
    const archiveBefore = stableArchive(await (await request('/api/archive/dynamics/91001')).json());
    const databaseBefore = await stat(database);
    // 进程对象的 pid 不会自己变化，用它自比是恒真的；改数 collector 启动日志条数。
    const collectorStarts = () => (logs.match(/collector_started/g) ?? []).length;
    const collectorStartsBefore = collectorStarts();
    assert.equal(collectorStartsBefore, 1, 'Collector should have started exactly once before the rollback');
    await rollbackAndVerify({
      baseURL, workspace, current, previousBuild: productionBuild, nextBuild: updated, page,
      navigate: async target => {
        const routes = [
          ['/', target.getByText('部署隔离正文', { exact: false }).first()],
          ['/ups/202', target.getByText('部署隔离正文', { exact: false }).first()],
          ['/dynamics/91001', target.getByText('部署隔离正文', { exact: false }).first()],
          ['/dynamics/91001/comments/91002', target.getByRole('button', { name: '返回评论' })],
          ['/manage', target.getByRole('link', { name: '管理 UP 202' })],
          ['/manage/ups/202', target.getByRole('heading', { name: '指定动态目标' })],
        ];
        for (const [path, anchor] of routes) {
          const response = await target.goto(`${baseURL}${path}`);
          assert.equal(response.status(), 200, `${path} after rollback`);
          await anchor.waitFor();
        }
      },
    });
    assert.equal(stableArchive(await (await request('/api/archive/dynamics/91001')).json()), archiveBefore,
      'Rolling back the frontend must not roll back or rewrite SQLite data');
    const databaseAfter = await stat(database);
    assert.equal(databaseAfter.ino, databaseBefore.ino, 'Database file was replaced during the frontend rollback');
    assert.equal(collector.exitCode, null, 'Collector was stopped by the frontend rollback');
    assert.equal(collectorStarts(), collectorStartsBefore, 'Collector was restarted by the frontend rollback');
    console.log('PASS: 生产产物原子切换与回退；SQLite 文件未替换、collector 未重启，归档内容不变');

    await stop(collector);
    await stop(api);
    // 上游进程不可达必须保留 502；诊断不得携带请求中的虚构秘密。
    const unavailable = await fetch(`${baseURL}/api/archive/ups?token=${deliverySecret}`);
    assert.equal(unavailable.status, 502);
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
    assert(!(await unavailable.text()).includes('<div id="app">'));
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
