import { expect, test } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApi, stopApi } from '../e2e-manage/apiProcess';

const factory = { factory: 'scoped_live_app:create_app', appDir: 'tests/e2e-archive' };
test('真实 SQLite/API→生产 Reader→全部与单 UP 页面、刷新和断源重开', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'bili-scoped-archive-'));
  const database = join(directory, 'archive.sqlite');
  let api: ChildProcess | undefined;
  try {
    api = await startApi(database, factory);
    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.reload();
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(20);
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(25);
    expect(await page.getByRole('article').evaluateAll(cards => cards.map(card => card.getAttribute('data-reading-id'))))
      .toEqual(['1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '1010', '1011', '1012', '1013',
        '1014', '1015', '1016', '1017', '1018', '1019', '1020', '1021', '1022', '1023', '1024', '1025']);
    await expect(page.getByText('动态已加载完毕', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
    await page.goto('/ups/123');
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.reload();
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(13);
    expect(await page.getByRole('article').evaluateAll(cards => cards.map(card => card.getAttribute('data-reading-id'))))
      .toEqual(['1001', '1003', '1005', '1007', '1009', '1011', '1013', '1015', '1017', '1019', '1021', '1023', '1025']);
    await page.getByRole('article').first().getByRole('button', { name: '查看详情', exact: true }).click();
    await expect(page.getByText('有限归档正文 1001', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(page).toHaveURL(/\/ups\/123$/);
    await expect(page.getByRole('article')).toHaveCount(13);
    await page.goto('/dynamics/1001');
    await page.reload();
    await expect(page.getByText('有限归档正文 1001', { exact: true })).toBeVisible();
    await page.goto('/ups/999');
    await expect(page.getByText('UP 不存在', { exact: true })).toBeVisible();
    await page.goto('/ups/789');
    await expect(page.getByText('暂无动态', { exact: true })).toBeVisible();
    await page.goto('/dynamics/999');
    await expect(page.getByText('动态不存在或不可用', { exact: true })).toBeVisible();
    await page.goto('/invalid');
    await expect(page.getByRole('heading', { name: '未找到页面', exact: true })).toBeVisible();
    expect((await page.request.delete('/api/manage/ups/123/monitor')).status()).toBe(204);
    expect((await page.request.patch('/api/manage/ups/456/monitor', { data: { mode: 'specified', recent_n: 10, enabled: false } })).status()).toBe(200);
    await stopApi(api);
    api = await startApi(database, factory);
    await page.goto('/ups/123');
    await expect(page.getByRole('article')).toHaveCount(10);
    await expect(page.getByRole('navigation', { name: '归档范围' }).getByRole('link', { name: '保留作者一', exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: '归档范围' }).getByRole('link', { name: '保留作者二', exact: true }).click();
    await expect(page).toHaveURL(/\/ups\/456$/);
    await expect(page.getByRole('article')).toHaveCount(10);
    await expect(page.getByText('有限归档正文 1002', { exact: true })).toBeVisible();
    await expect(page.getByText('有限归档正文 1001', { exact: true })).toHaveCount(0);
    await page.route('**/api/archive/dynamics?**', route => route.abort());
    await page.reload();
    await expect(page.getByText('动态列表读取失败，请重试。', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无动态', { exact: true })).toHaveCount(0);
  } finally {
    if (api) await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});
