import { expect, test } from '@playwright/test';

// 生产装配：六条正式路由与 404 必须可达，且不存在任何自检入口。
test('生产装配渲染六条正式路由与不存在页', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'production', '只在生产装配执行');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();

  await page.goto('/ups/7');
  await expect(page.getByRole('heading', { name: 'UP 7 归档' })).toBeVisible();

  await page.goto('/dynamics/abc');
  await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();

  await page.goto('/dynamics/abc/comments/root-1');
  await expect(page.getByRole('heading', { name: '楼中楼' })).toBeVisible();

  await page.goto('/manage');
  await expect(page.getByRole('heading', { name: '监控管理' })).toBeVisible();

  await page.goto('/manage/ups/9');
  await expect(page.getByRole('heading', { name: '单 UP 管理' })).toBeVisible();

  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
});

test('生产装配没有自检入口、装配标识或自检路由', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'production', '只在生产装配执行');

  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link', { name: '归档' })).toBeVisible();
  await expect(nav.getByRole('link', { name: '监控管理' })).toBeVisible();
  await expect(nav.getByRole('link', { name: '图片自检' })).toHaveCount(0);
  await expect(page.locator('.app-badge')).toHaveCount(0);

  // 自检路由在生产装配下不存在，落到不存在页而不是可用的自检页面。
  await page.goto('/__preview-fixtures');
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
});

test('fault 装配与 mock 装配相互独立', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'fault', '只在 fault 装配执行');

  await page.goto('/');
  await expect(page.locator('.app-badge')).toHaveText('fault');
  await expect(page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '图片自检' })).toBeVisible();

  // fault 装配使用同一份受控归档，但列表首次读取失败一次；重试后恢复。
  await expect(page.getByRole('alert')).toHaveText('动态列表读取失败，请重试。');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('article')).toHaveCount(10);

  await page.goto('/__preview-fixtures');
  await expect(page.getByRole('heading', { name: '图片预览与浏览器历史验证' })).toBeVisible();
});
