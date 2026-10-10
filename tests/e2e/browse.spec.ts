import { expect, test } from '@playwright/test';

const firstId = '90071992547409931';

test('列表 → 文字详情顶部 → 返回来源列表 → 浏览器前进', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', request => {
    if (!request.url().startsWith('http://127.0.0.1:4173')) externalRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '纸飞机' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(10);
  await expect(page.getByText('2026-03-01 10:03:04')).toBeVisible();
  const card = page.getByRole('article').last();
  await card.getByRole('button', { name: '查看详情' }).click();
  await expect(page).toHaveURL(/\/dynamics\/90071992547409940$/);
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('article')).toHaveCount(10);
  await page.goForward();
  await expect(page).toHaveURL(/\/dynamics\/90071992547409940$/);
  await expect(page.getByText('文字日记 10', { exact: false })).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test('有效详情直达、刷新后可阅读安全完整正文，无来源返回首页', async ({ page }) => {
  await page.goto(`/dynamics/${firstId}?fault=1`);
  await expect(page.getByText(/第八行/)).toBeVisible();
  await expect(page.getByRole('article').locator('script')).toHaveCount(0);
  await expect(page.getByRole('article').getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => '__unsafeTextExecuted' in window)).toBe(false);
  await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(/第八行/)).toBeVisible();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('article')).toHaveCount(10);
});

test('刷新遗留来源标记后返回仍去首页，不沿用已失效的会话历史', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '查看详情' }).first().click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${firstId}$`));
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('正文选择、头像昵称不跳转；键盘操作可聚焦且焦点可见', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('article').first();
  await card.getByText('纸飞机', { exact: true }).click();
  await card.getByRole('img').click();
  await card.locator('p').first().evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('第八行');
  await page.keyboard.press('Tab');
  const expand = card.getByRole('button', { name: '展开正文' });
  await expect(expand).toBeFocused();
  expect(await expand.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(card.getByRole('button', { name: '收起正文' })).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press('Tab');
  const comments = card.getByRole('button', { name: '评论 45', exact: true });
  await expect(comments).toBeFocused();
  const commentBox = await comments.boundingBox();
  expect(commentBox?.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Tab');
  const action = page.getByRole('button', { name: '查看详情' }).first();
  await expect(action).toBeFocused();
  expect(await action.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  const box = await action.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
});

test('四种约定宽度下列表和详情均无横向溢出', async ({ page }) => {
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/', `/dynamics/${firstId}`]) {
      await page.goto(path);
      await expect(page.getByRole('article').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
});

test('不存在动态与未知页面分别提示并可返回列表', async ({ page }) => {
  await page.goto('/dynamics/absent');
  await expect(page.getByText('动态不存在或不可用')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/not/a/page');
  await expect(page.getByRole('heading', { name: '未找到页面' })).toBeVisible();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page.getByRole('article')).toHaveCount(10);
});
