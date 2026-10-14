import { expect, test, type Locator } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logsOf, startApi, stopApi } from '../e2e-manage/apiProcess';

const uid = '202';
const normalId = '9101';
const factory = { factory: 'live_app:create_app', appDir: 'tests/e2e-archive' };

async function expectNoArchiveInfo(card: Locator) {
  await expect(card).toBeVisible();
  await expect(card.getByRole('complementary', { name: '归档状态', includeHidden: true })).toHaveCount(0);
  await expect(card).not.toContainText(/编辑于|编辑信号|正文访问受限|正文尚未成功归档|最近正文|已保存内容仍可阅读|已有归档状态未覆盖|图片待归档（\d+ 张）|来源评论：|本地已归档|正文(?:已保存|待同步|读取失败|受限)；媒体/);
}

test('目标校验与归档契约穿透生产装配，列表详情无归档信息且断源重开仍可阅读', async ({ page }) => {
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
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(4);
    for (const card of await cards.all()) await expectNoArchiveInfo(card);
    const normalCard = page.locator(`article[data-reading-id="${normalId}"]`);
    await expect(normalCard.getByText('暂无内容', { exact: true })).toHaveCount(0);
    await expect(normalCard.getByRole('button', { name: '来源评论 7', exact: true })).toBeVisible();
    await page.goto(`/dynamics/${normalId}`);
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    await expect(page.getByText('虚构页面标题', { exact: true })).toBeVisible();
    await expect(page.getByText('2026-10-09 10:38:16', { exact: false })).toBeVisible();
    await expectNoArchiveInfo(page.getByRole('article'));
    await expect(page.getByText('暂无内容', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '来源评论 7', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '评论区', exact: true }).getByRole('heading', { name: /评论.*7/ })).toBeVisible();
    expect(await page.evaluate(() => '__fixtureExecuted' in window)).toBe(false);
    await expect(page.locator('img[src*="source-business"]')).toHaveCount(0);
    const archived = await page.request.get(`/api/archive/dynamics/${normalId}`);
    expect(archived.ok()).toBe(true);
    expect(await archived.json()).toMatchObject({ id: normalId, content_state: 'success', last_attempt: 'success',
      edited_at: '2026-10-09T13:01+08:00', edit_status: 'observed',
      source_comment_count: 7, local_comment_count: 0 });
    await page.goto('/dynamics/9102');
    await expect(page.getByText('暂无内容', { exact: true })).toBeVisible();
    await expectNoArchiveInfo(page.getByRole('article'));
    expect(await (await page.request.get('/api/archive/dynamics/9102')).json()).toMatchObject({ content_state: 'success', text: '' });
    for (const [id, contentState] of [['9103', 'restricted'], ['9104', 'failed']] as const) {
      await page.goto(`/dynamics/${id}`);
      await expectNoArchiveInfo(page.getByRole('article'));
      await expect(page.getByText('暂无内容', { exact: true })).toHaveCount(0);
      expect(await (await page.request.get(`/api/archive/dynamics/${id}`)).json()).toMatchObject({ content_state: contentState });
    }
    await page.goto('/dynamics/9197');
    await expect(page.getByText('动态不存在', { exact: false })).toBeVisible();

    await stopApi(api);
    api = await startApi(database, { ...factory, env: { FIXTURE_OFFLINE: '1' } });
    const retry = await page.request.post('/api/sync/initial', { data: { uid } });
    expect(await retry.json()).toEqual({ processed: 4, succeeded: 0, failed: 4 });
    await page.goto(`/dynamics/${normalId}`);
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    await expectNoArchiveInfo(page.getByRole('article'));
    await expect(page.getByText('暂无内容', { exact: true })).toHaveCount(0);
    const retained = await (await page.request.get(`/api/archive/dynamics/${normalId}`)).json();
    expect(retained).toMatchObject({ content_state: 'success', last_attempt: 'failed',
      edited_at: '2026-10-09T13:01+08:00' });
    await page.request.delete(`/api/manage/ups/${uid}/targets/${normalId}`);
    await page.request.delete(`/api/manage/ups/${uid}/monitor`);
    await stopApi(api);
    api = await startApi(database, { ...factory, env: { FIXTURE_OFFLINE: '1' } });
    await page.reload();
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    await expectNoArchiveInfo(page.getByRole('article'));
    await expect(page.getByText('暂无内容', { exact: true })).toHaveCount(0);
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
