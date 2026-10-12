import { expect, test } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logsOf, startApi, stopApi } from '../e2e-manage/apiProcess';

const uid = '202';
const normalId = '9101';
const factory = { factory: 'live_app:create_app', appDir: 'tests/e2e-archive' };

test('目标校验、首次同步、真实归档阅读和断源重开穿透生产装配', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'bili-initial-archive-'));
  const database = join(directory, 'archive.sqlite');
  let api: ChildProcess | undefined;
  try {
    api = await startApi(database, factory);
    await page.route('https://example.invalid/**', route => route.abort());
    await page.goto('/');
    await expect(page.getByText('暂无动态', { exact: false })).toBeVisible();
    await page.goto('/manage');
    await page.getByLabel('UP UID', { exact: true }).fill(uid);
    await page.getByRole('button', { name: '添加监控', exact: true }).click();
    const up = page.getByRole('article', { name: `UP ${uid}`, exact: true });
    await expect(up).toBeVisible();
    await up.getByLabel('监控模式', { exact: true }).selectOption('specified');
    await up.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(up.getByText('保存成功。', { exact: true })).toBeVisible();
    await up.getByLabel('动态 ID', { exact: true }).fill(normalId);
    await up.getByRole('button', { name: '校验并添加目标', exact: true }).click();
    await expect(up.getByText('归属校验通过，目标关联已保存。', { exact: true })).toBeVisible();
    for (const id of ['9102', '9103', '9104']) {
      const response = await page.request.post(`/api/manage/ups/${uid}/targets`, { data: { id } });
      expect(response.ok()).toBe(true);
    }
    await up.getByLabel('动态 ID', { exact: true }).fill('9198');
    await up.getByRole('button', { name: '校验并添加目标', exact: true }).click();
    await expect(up.getByText('动态作者与所选 UP 不符。', { exact: true })).toBeVisible();
    await up.getByLabel('动态 ID', { exact: true }).fill('9199');
    await up.getByRole('button', { name: '校验并添加目标', exact: true }).click();
    await expect(up.getByText('无法确认动态归属。', { exact: true })).toBeVisible();
    expect(await (await page.request.get(`/api/manage/ups/${uid}/targets`)).json())
      .toEqual({ targets: [{ id: '9101' }, { id: '9102' }, { id: '9103' }, { id: '9104' }] });
    expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
    const first = await page.request.post('/api/sync/initial', { data: { uid } });
    expect(await first.json()).toEqual({ processed: 4, succeeded: 2, failed: 2 });
    await page.goto('/');
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    await page.goto(`/dynamics/${normalId}`);
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    await expect(page.getByText('虚构页面标题', { exact: true })).toBeVisible();
    await expect(page.getByText('2026-10-09 10:38:16', { exact: false })).toBeVisible();
    await expect(page.getByText('2026-10-09 13:01', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => '__fixtureExecuted' in window)).toBe(false);
    await expect(page.locator('img[src*="source-business"]')).toHaveCount(0);
    const archived = await page.request.get(`/api/archive/dynamics/${normalId}`);
    expect(await archived.json()).toMatchObject({ id: normalId, content_state: 'success',
      source_comment_count: 7, local_comment_count: 0 });
    await page.goto('/dynamics/9102');
    await expect(page.getByText('暂无内容', { exact: true })).toBeVisible();
    await page.goto('/dynamics/9103');
    await expect(page.getByText('正文访问受限。', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无内容', { exact: true })).toHaveCount(0);
    await expect(page.getByText('已保存内容仍可阅读。', { exact: true })).toHaveCount(0);
    await page.goto('/dynamics/9104');
    await expect(page.getByText('正文尚未成功归档。', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无内容', { exact: true })).toHaveCount(0);
    await expect(page.getByText('已保存内容仍可阅读。', { exact: true })).toHaveCount(0);
    await page.goto('/dynamics/9197');
    await expect(page.getByText('动态不存在', { exact: false })).toBeVisible();

    await stopApi(api);
    api = await startApi(database, { ...factory, env: { FIXTURE_OFFLINE: '1' } });
    const retry = await page.request.post('/api/sync/initial', { data: { uid } });
    expect(await retry.json()).toEqual({ processed: 4, succeeded: 0, failed: 4 });
    await page.goto(`/dynamics/${normalId}`);
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    const retained = await (await page.request.get(`/api/archive/dynamics/${normalId}`)).json();
    expect(retained).toMatchObject({ content_state: 'success', last_attempt: 'failed',
      edited_at: '2026-10-09T13:01+08:00' });
    await page.request.delete(`/api/manage/ups/${uid}/targets/${normalId}`);
    await page.request.delete(`/api/manage/ups/${uid}/monitor`);
    await stopApi(api);
    api = await startApi(database, { ...factory, env: { FIXTURE_OFFLINE: '1' } });
    await page.reload();
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    expect(await (await page.request.post('/api/sync/initial', { data: { uid } })).json())
      .toEqual({ processed: 0, succeeded: 0, failed: 0 });
    expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
    await page.route('**/api/archive/**', route => route.abort());
    await page.goto('/');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await expect(page.getByText('暂无动态', { exact: false })).toHaveCount(0);
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
  } finally {
    if (api) await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});
