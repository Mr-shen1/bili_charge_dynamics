import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const apiUrl = 'http://127.0.0.1:4176/api/manage/ups';
const largeUid = '900719925474099312345';
const apiLogs = new WeakMap<ChildProcess, () => string>();

async function stopApi(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  // Signal only the process group created by this test (uv and its Uvicorn child).
  const signal = (name: NodeJS.Signals) => {
    if (child.pid && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, name);
  };
  signal('SIGTERM');
  const forceStop = setTimeout(() => signal('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(forceStop); }
}

async function startApi(database: string) {
  const probe = createServer();
  probe.listen(4176, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const child = spawn('uv', ['run', '--no-sync', 'python', '-m', 'uvicorn',
    'backend.tests.live_app:create_app', '--factory', '--host', '127.0.0.1', '--port', '4176'], {
    env: { ...process.env, BILI_DATABASE_PATH: database },
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let startupError: Error | undefined;
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  child.on('error', error => { startupError = error; });
  apiLogs.set(child, () => output);
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Test API exited: ${output}`);
      try {
        const response = await fetch(apiUrl, { signal: AbortSignal.timeout(500) });
        if (response.ok && Array.isArray((await response.json()).ups)) return child;
      } catch { /* Wait for this process, never reuse an existing server. */ }
      await delay(100);
    }
    throw new Error(`Test API not ready: ${output}`);
  } catch (error) { await stopApi(child); throw error; }
}

test('实际 API 保存两 UP 配置，服务重启和页面刷新后仍可读，删除保留身份', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'bili-management-'));
  const database = join(directory, 'monitor.sqlite');
  let api: ChildProcess | undefined;
  try {
    api = await startApi(database);
    await page.route('https://example.invalid/**', route => route.abort());
    await page.goto('/manage');
    await expect(page.getByText('尚未保存 UP，请输入 UID 添加。')).toBeVisible();
    for (const uid of [largeUid, '202']) {
      await page.getByLabel('UP UID', { exact: true }).fill(uid);
      await page.getByRole('button', { name: '添加监控', exact: true }).click();
      await expect(page.getByRole('article', { name: `UP ${uid}`, exact: true })).toBeVisible();
    }
    const star = page.getByRole('article', { name: `UP ${largeUid}`, exact: true });
    const dawn = page.getByRole('article', { name: 'UP 202', exact: true });
    await expect(star.getByLabel('近期 N 条', { exact: true })).toHaveValue('10');
    await expect(dawn.getByLabel('近期 N 条', { exact: true })).toHaveValue('10');
    await star.getByLabel('近期 N 条', { exact: true }).fill('17');
    await star.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(star.getByText('保存成功。')).toBeVisible();
    await dawn.getByLabel('近期 N 条', { exact: true }).fill('23');
    await dawn.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(dawn.getByText('保存成功。')).toBeVisible();
    await star.getByLabel('监控模式', { exact: true }).selectOption('specified');
    await star.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(star.getByText('保存成功。')).toBeVisible();
    await star.getByRole('button', { name: '停止监控', exact: true }).click();
    await expect(star.getByText('监控：已停止', { exact: true })).toBeVisible();

    await stopApi(api);
    api = await startApi(database);
    await page.reload();
    await expect(star.getByLabel('监控模式', { exact: true })).toHaveValue('specified');
    await expect(star.getByText('监控：已停止', { exact: true })).toBeVisible();
    await expect(star.getByText('最近检查：未检查', { exact: true })).toBeVisible();
    await expect(dawn.getByLabel('近期 N 条', { exact: true })).toHaveValue('23');
    await expect(dawn.getByText('监控：已启用', { exact: true })).toBeVisible();
    const stored = await (await fetch(`${apiUrl}/${largeUid}`)).json();
    expect(stored.monitor).toMatchObject({ mode: 'specified', recent_n: 17, enabled: false,
      last_checked_at: null, last_succeeded_at: null });
    await star.getByRole('button', { name: '删除监控配置', exact: true }).click();
    await expect(star.getByText('监控配置已删除；身份和已有归档保留。', { exact: true })).toBeVisible();
    await stopApi(api);
    api = await startApi(database);
    await page.reload();
    await expect(star.getByText('虚构星海', { exact: true })).toBeVisible();
    await expect(star.getByText('监控配置已删除；身份和已有归档保留。', { exact: true })).toBeVisible();
    const retained = await fetch(`${apiUrl}/${largeUid}`);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ uid: largeUid, name: '虚构星海', monitor: null });
    await expect(dawn.getByLabel('近期 N 条', { exact: true })).toHaveValue('23');
  } finally {
    if (api) await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});

test('实际上游拒绝显示失败，可键盘原位重试，四宽度无页面横向溢出', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'bili-management-errors-'));
  let api: ChildProcess | undefined;
  try {
    api = await startApi(join(directory, 'monitor.sqlite'));
    await page.route('https://example.invalid/**', route => route.abort());
    await page.goto('/manage');
    await page.getByLabel('UP UID', { exact: true }).fill('303');
    await page.getByLabel('UP UID', { exact: true }).press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText('添加成功。', { exact: true })).toHaveCount(0);
    expect(await (await fetch(apiUrl)).json()).toEqual({ ups: [] });
    const invalid = await page.request.post('/api/manage/ups?token=FICTIONAL_SECRET_LIVE_QUERY', {
      data: { uid: 'FICTIONAL_SECRET_LIVE_INPUT' },
    });
    expect(invalid.status()).toBe(422);
    expect(await invalid.text()).not.toContain('FICTIONAL_SECRET');
    expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
    await page.getByLabel('UP UID', { exact: true }).fill('202');
    await page.getByLabel('UP UID', { exact: true }).press('Tab');
    await expect(page.getByRole('button', { name: '添加监控', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('article', { name: 'UP 202', exact: true })).toBeVisible();
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await stopApi(api);
    const logs = apiLogs.get(api)?.();
    expect(logs).toContain('Application startup complete.');
    expect(logs).not.toContain('FICTIONAL_SECRET');
  } finally {
    if (api) await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});
