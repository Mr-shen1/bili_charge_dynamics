import { expect, test } from '@playwright/test';

const firstId = '90071992547409931';

test('正常25条回复3/13/23/25、收起缓存恢复、排序重置及完整计数', async ({ page }) => {
  await page.goto(`/dynamics/${firstId}`);
  const area = page.getByRole('region', { name: '回复区 comment-44', exact: true });
  const rows = area.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(page.getByText('回复 25', { exact: true })).toBeVisible();
  await expect(page.getByRole('article').getByText('评论 70', { exact: true })).toBeVisible();
  const expand = area.getByRole('button', { name: '展开回复', exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.focus();
  expect(await expand.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  expect(await expand.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  await expect(rows).toHaveCount(13);
  await area.getByRole('button', { name: '收起回复', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await expand.click();
  await expect(rows).toHaveCount(13);
  await area.getByRole('button', { name: '加载更多回复', exact: true }).click();
  await expect(rows).toHaveCount(23);
  await area.getByRole('button', { name: '加载更多回复', exact: true }).click();
  await expect(rows).toHaveCount(25);
  await expect(area.getByText('回复已加载完毕')).toBeVisible();
  await expect(area.getByRole('button', { name: '加载更多回复', exact: true })).toHaveCount(0);
  const times = await rows.locator('time').allTextContents();
  expect(times).toEqual([...times].sort());
  await area.getByRole('button', { name: '收起回复', exact: true }).click();
  await expand.click();
  await expect(rows).toHaveCount(25);
  await page.getByRole('button', { name: '最新', exact: true }).click();
  await expect(area).toHaveCount(0);
  await page.getByRole('button', { name: '加载更多评论' }).click();
  await page.getByRole('button', { name: '加载更多评论' }).click();
  await expect(rows).toHaveCount(3);
  await expect(expand).toBeVisible();
  await expect(rows.first()).toContainText('长回复 1');
  await expect(rows.first().getByText('UP主', { exact: true })).toBeVisible();
  await expect(rows.nth(1).getByText('UP主', { exact: true })).toHaveCount(0);
  await expect(rows.nth(2).getByText('回复 @纸飞机', { exact: true })).toHaveCount(0);
  await expect(page.getByText('回复 25', { exact: true })).toBeVisible();
  await expect(page.getByRole('article').getByText('评论 70', { exact: true })).toBeVisible();
});

test('回复正文超过实际六行才折叠，键盘展开收起、安全文字与四宽度长昵称/目标可读', async ({ page }) => {
  await page.goto(`/dynamics/${firstId}`);
  const area = page.getByRole('region', { name: '回复区 comment-44', exact: true });
  await expect(area.getByRole('listitem')).toHaveCount(3);
  const row = area.getByRole('listitem').first();
  const expandText = row.getByRole('button', { name: '展开回复正文', exact: true });
  const text = row.locator('p').filter({ hasText: '长回复 1' });
  const lines = () => text.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight));
  await expect(expandText).toBeVisible();
  expect(await lines()).toBeCloseTo(6, 1);
  await expandText.focus();
  await page.keyboard.press('Enter');
  expect(await lines()).toBeGreaterThan(6);
  await expect(row.getByRole('button', { name: '收起回复正文', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await lines()).toBeCloseTo(6, 1);
  await area.getByRole('button', { name: '展开回复', exact: true }).click();
  const longRow = area.getByRole('listitem').nth(3);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const wordExpand = longRow.getByRole('button', { name: '展开回复正文', exact: true });
    if (await wordExpand.count()) await wordExpand.click();
    await expect(longRow.getByText(`长回复昵称`.repeat(30), { exact: true })).toBeVisible();
    await expect(longRow.getByText(`回复 @${'长目标昵称'.repeat(30)}`, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await expect(area.getByRole('listitem').nth(4).getByRole('button', { name: /回复正文/ })).toHaveCount(0);
  await expect(area.locator('script')).toHaveCount(0);
  await expect(area.getByRole('link')).toHaveCount(0);
  expect(await page.evaluate(() => '__unsafeTextExecuted' in window)).toBe(false);
});
