import { expect, test, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { logsOf, startApi, stopApi } from './apiProcess';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apiUrl = 'http://127.0.0.1:4176/api/manage/ups';
const largeUid = '900719925474099312345';
function upLink(page: Page, uid: string) {
  return page.getByRole('link', { name: `管理 UP ${uid}`, exact: true });
}
function upArticle(page: Page, uid: string) {
  return page.getByRole('article', { name: `UP ${uid}`, exact: true });
}
// UP 列表只列身份与状态；配置、目标与检查状态在单 UP 管理页。
async function openUp(page: Page, uid: string) {
  await upLink(page, uid).click();
  await expect(upArticle(page, uid)).toBeVisible();
}
async function backToList(page: Page) {
  await page.getByRole('link', { name: 'UP 列表', exact: true }).click();
  await expect(page.getByRole('list', { name: 'UP 列表', exact: true })).toBeVisible();
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
      await expect(upLink(page, uid)).toBeVisible();
    }
    await openUp(page, largeUid);
    const star = upArticle(page, largeUid);
    await expect(star.getByLabel('近期 N 条', { exact: true })).toHaveValue('10');
    await star.getByLabel('近期 N 条', { exact: true }).fill('17');
    await star.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(star.getByText('保存成功。')).toBeVisible();
    await star.getByLabel('监控模式', { exact: true }).selectOption('specified');
    await star.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(star.getByText('保存成功。')).toBeVisible();
    // 新建配置的启停初值由后端决定，这里按实际状态启停一次，再沿用该状态做重启断言。
    const startEnabled = (await star.locator('.manage-badge').innerText()).includes('已启用');
    await star.getByRole('button', { name: /^(停止监控|启用监控)$/, exact: true }).click();
    const toggledEnabled = !startEnabled;
    await expect(star.getByText(`监控：${toggledEnabled ? '已启用' : '已停止'}`, { exact: true })).toBeVisible();

    await backToList(page);
    await openUp(page, '202');
    const dawn = upArticle(page, '202');
    await expect(dawn.getByLabel('近期 N 条', { exact: true })).toHaveValue('10');
    await dawn.getByLabel('近期 N 条', { exact: true }).fill('23');
    await dawn.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(dawn.getByText('保存成功。')).toBeVisible();
    const dawnEnabled = (await dawn.locator('.manage-badge').innerText()).includes('已启用');

    await stopApi(api);
    api = await startApi(database);
    await page.reload();
    await expect(dawn).toBeVisible();
    await expect(dawn.getByLabel('近期 N 条', { exact: true })).toHaveValue('23');
    await expect(dawn.getByText(`监控：${dawnEnabled ? '已启用' : '已停止'}`, { exact: true })).toBeVisible();
    const discoveryRead = page.waitForResponse(response => response.url().endsWith('/api/manage/ups/202/discovery'));
    await dawn.getByRole('button', { name: '读取发现状态', exact: true }).click();
    expect(await (await discoveryRead).json()).toMatchObject({
      mode: 'recent', recent_n: 23, current_ids: [], trusted_result: null, status: 'undiscovered',
    });
    await expect(dawn.getByText('尚未开始发现。', { exact: true })).toBeVisible();
    await expect(dawn.getByText(`读取时已保存模式：近期 N 条；N：23；监控：${dawnEnabled ? '已启用' : '已停止'}。`,
      { exact: true })).toBeVisible();
    await expect(dawn.getByText('当前无启用的近期目标；不表示历史归档已删除。', { exact: true })).toBeVisible();

    await backToList(page);
    await openUp(page, largeUid);
    await expect(star.getByLabel('监控模式', { exact: true })).toHaveValue('specified');
    await expect(star.getByText(`监控：${toggledEnabled ? '已启用' : '已停止'}`, { exact: true })).toBeVisible();
    await expect(star.getByText('最近检查：未检查', { exact: true })).toBeVisible();
    await expect(star.getByText('最近成功：尚未成功', { exact: true })).toBeVisible();
    const checksRead = page.waitForResponse(response => response.url().endsWith(`/api/manage/ups/${largeUid}/checks`));
    await star.getByRole('button', { name: '读取检查状态', exact: true }).click();
    expect(await (await checksRead).json()).toEqual({ checks: [] });
    await expect(star.getByText('尚无目标检查记录。', { exact: true })).toBeVisible();
    const stored = await (await fetch(`${apiUrl}/${largeUid}`)).json();
    expect(stored.monitor).toMatchObject({ mode: 'specified', recent_n: 17, enabled: toggledEnabled,
      last_checked_at: null, last_succeeded_at: null });
    await star.getByRole('button', { name: '删除监控配置', exact: true }).click();
    await expect(star.getByText('监控配置已删除；身份和已有归档保留。', { exact: true })).toBeVisible();
    await stopApi(api);
    api = await startApi(database);
    await page.reload();
    await expect(star).toBeVisible();
    await expect(star.getByText('虚构星海', { exact: true })).toBeVisible();
    await expect(star.getByText('监控配置已删除；身份和已有归档保留。', { exact: true })).toBeVisible();
    await star.getByRole('button', { name: '读取检查状态', exact: true }).click();
    await expect(star.getByText('尚无目标检查记录。', { exact: true })).toBeVisible();
    const retained = await fetch(`${apiUrl}/${largeUid}`);
    expect(retained.status).toBe(200);
    expect(await retained.json()).toMatchObject({ uid: largeUid, name: '虚构星海', monitor: null });
    await backToList(page);
    await expect(upLink(page, '202')).toContainText(`监控${dawnEnabled ? '已启用' : '已停止'}`);
    await openUp(page, '202');
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
    await expect(upLink(page, '202')).toBeVisible();
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    // 单 UP 管理页同样不产生整页横向溢出。
    await openUp(page, '202');
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await stopApi(api);
    const logs = logsOf(api);
    expect(logs).toContain('Application startup complete.');
    expect(logs).not.toContain('FICTIONAL_SECRET');
  } finally {
    if (api) await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});
