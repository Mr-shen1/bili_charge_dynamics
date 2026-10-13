import { expect, test } from '@playwright/test';

const firstId = '90071992547409931';

test('列表评论数进入同一详情定位评论区；返回后阅读全文明确从顶部进入', async ({ page }) => {
  await page.goto('/');
  const first = page.getByRole('article').first();
  const entry = first.getByRole('button', { name: '评论 70', exact: true });
  await entry.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/dynamics/${firstId}$`));
  const area = page.getByRole('region', { name: '评论区' });
  const rows = area.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
  await expect(rows).toHaveCount(20);
  await expect.poll(() => area.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(0, 0);
  await area.getByRole('button', { name: '加载更多评论' }).click();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page).toHaveURL(/\/$/);
  await first.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  await expect(rows).toHaveCount(20);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('两种排序各读完45条不重复，四宽度评论、展开长词与长昵称不溢出', async ({ page }) => {
  await page.goto(`/dynamics/${firstId}`);
  const area = page.getByRole('region', { name: '评论区' });
  const rows = area.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
  for (const sort of ['最热', '最新']) {
    await area.getByRole('button', { name: sort, exact: true }).click();
    await expect(rows).toHaveCount(20);
    await area.getByRole('button', { name: '加载更多评论' }).click();
    await expect(rows).toHaveCount(40);
    await area.getByRole('button', { name: '加载更多评论' }).click();
    await expect(rows).toHaveCount(45);
    await expect(area.getByText('评论已加载完毕')).toBeVisible();
    await expect(area.getByRole('button', { name: '加载更多评论' })).toHaveCount(0);
    expect(new Set(await rows.allTextContents()).size).toBe(45);
    await expect(page.getByRole('article').getByText('评论 70', { exact: true })).toBeVisible();
  }
  await area.getByRole('button', { name: '最热' }).click();
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const longWord = rows.filter({ hasText: '长词' });
    if (await longWord.getByRole('button', { name: '展开评论' }).count()) {
      await longWord.getByRole('button', { name: '展开评论' }).click();
    }
    await expect(rows.first().getByRole('button', { name: '展开评论', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(area.getByRole('link')).toHaveCount(0);
  }
});

test('评论实际超过六行折叠、键盘展开收起，切换排序回首批和评论顶部，动态节点不重置', async ({ page }) => {
  await page.goto(`/dynamics/${firstId}`);
  const area = page.getByRole('region', { name: '评论区' });
  const rows = area.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
  await expect(rows).toHaveCount(20);
  const upper = page.getByRole('article');
  // DOM节点连续性验证上方正文不因评论操作重新初始化。
  const original = await upper.elementHandle();
  const row = rows.first();
  const text = row.locator('p').first();
  const lines = () => text.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight));
  const expand = row.getByRole('button', { name: '展开评论' });
  await expect(expand).toBeVisible();
  expect(await lines()).toBeCloseTo(6, 1);
  await expand.focus();
  expect(await expand.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  expect(await lines()).toBeGreaterThan(6);
  await expect(row.getByRole('button', { name: '收起评论' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await lines()).toBeCloseTo(6, 1);
  await expand.click();
  await expect(row.locator('script')).toHaveCount(0);
  await expect(area.getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => '__unsafeTextExecuted' in window)).toBe(false);
  await area.getByRole('button', { name: '加载更多评论' }).click();
  await expect(rows).toHaveCount(40);
  await area.getByRole('button', { name: '最新' }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText('长评论 1');
  await expect.poll(() => area.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(0, 0);
  await expect(area.getByRole('button', { name: '收起评论' })).toHaveCount(0);
  await area.getByRole('button', { name: '最热' }).click();
  await expect(rows.first()).toContainText('长评论 45');
  await expect(area.getByRole('button', { name: '收起评论' })).toHaveCount(0);
  expect(await original?.evaluate(element => element.isConnected)).toBe(true);
  await expect(upper).toContainText('第八行');
});
