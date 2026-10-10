import { expect, test } from '@playwright/test';

for (const method of ['页面返回', '浏览器后退'] as const) {
  test(`多批展开后通过${method}恢复范围、展开状态及稳定定位点`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('article').first().getByRole('button', { name: '展开正文' }).click();
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(20);
    const anchor = page.getByRole('article').nth(12);
    await anchor.evaluate(element => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 40));
    const offset = await anchor.evaluate(element => element.getBoundingClientRect().top);
    await anchor.getByRole('button', { name: '查看详情' }).click();
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    // 返回时宽度变化，用稳定锚点而不是旧像素定位。
    await page.setViewportSize({ width: 360, height: 800 });
    if (method === '页面返回') await page.getByRole('button', { name: '返回列表' }).click();
    else await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(20);
    await expect(page.getByRole('article').first().getByRole('button', { name: '收起正文' })).toHaveCount(1);
    await expect.poll(() => anchor.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(offset, 0);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(25);
    await expect(page.getByText('动态已加载完毕')).toBeVisible();
    await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);
    const times = await page.getByRole('article').locator('time').allTextContents();
    expect(new Set(times).size).toBe(25);
  });
}

test('恢复尚未执行时的主动滚轮优先，迟到帧不把用户拉回', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  const anchor = page.getByRole('article').nth(12);
  await anchor.getByRole('button', { name: '查看详情' }).click();
  await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  // 控制时间边界，让历史返回的两个布局帧暂不执行。
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.getByRole('button', { name: '返回列表' }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(page.getByRole('article')).toHaveCount(20);
  // mouse.wheel 发送后不保证 DOM 已收到事件；先确认输入到达，再推进恢复帧。
  const wheelReceived = page.evaluate(() => new Promise<void>(resolve => {
    window.addEventListener('wheel', () => resolve(), { once: true });
  }));
  await page.mouse.wheel(0, 300);
  await wheelReceived;
  await page.clock.runFor(100);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(1000);
  const afterUser = await page.evaluate(() => window.scrollY);
  await page.clock.runFor(500);
  expect(await page.evaluate(() => window.scrollY)).toBe(afterUser);
});

test('长词按实际排版随视口改变折叠入口，四种宽度展开和详情均不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const card = page.getByRole('article').nth(2);
  await expect(card).toContainText('长词');
  await expect(card.getByRole('button', { name: '展开正文' })).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(card.getByRole('button', { name: '展开正文' })).toBeVisible();
  await card.getByRole('button', { name: '展开正文' }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(card.getByRole('button', { name: '收起正文' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(card.getByRole('button', { name: '收起正文' })).toBeVisible();
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(card.getByRole('link')).toHaveCount(0);
  }
  await card.getByRole('button', { name: '查看详情' }).click();
  await expect(page).toHaveURL(/\/dynamics\/90071992547409933$/);
  await expect(page.getByRole('article')).toHaveCount(1);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.getByRole('article')).toContainText('长词');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('列表实际超过六行才折叠，可展开收起；详情完整展示', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('article').first();
  const text = card.locator('p').first();
  const expand = card.getByRole('button', { name: '展开正文' });
  await expect(expand).toBeVisible();
  expect(await text.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))).toBeCloseTo(6, 1);
  await expect(page.getByRole('article').nth(1).getByRole('button', { name: '展开正文' })).toHaveCount(0);
  await expand.click();
  expect(await text.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))).toBeGreaterThan(6);
  await expect(page).toHaveURL(/\/$/);
  await card.getByRole('button', { name: '收起正文' }).click();
  expect(await text.evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))).toBeCloseTo(6, 1);
  await card.getByRole('button', { name: '查看详情' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '展开正文' })).toHaveCount(0);
  expect(await page.getByRole('article').locator('p').first().evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight))).toBeGreaterThan(6);
});
