import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4174' });

test('专用故障装配确定性列表/详情失败重试，长昵称不撑宽页面', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('动态列表读取失败');
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByRole('article')).toHaveCount(10);
  await page.getByRole('button', { name: '查看详情' }).first().click();
  await expect(page.getByRole('alert')).toContainText('动态详情读取失败');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText(/第八行/)).toBeVisible();
});
