import { expect, test, type Locator } from '@playwright/test';

const firstId = '90071992547409931';
const directRows = (area: Locator) => area.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
const position = (anchor: Locator) => anchor.evaluate(element => element.getBoundingClientRect().top);
const locate = (anchor: Locator) => anchor.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 40));

test('列表与详情双向恢复评论/回复/文字范围，宽度变化后仍可见同一回复', async ({ page }) => {
  await page.goto('/');
  const listCard = page.getByRole('article').first();
  await listCard.getByRole('button', { name: '展开正文', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  await locate(listCard);
  await listCard.getByRole('button', { name: '评论 70', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(page).toHaveURL(new RegExp(`/dynamics/${firstId}$`));
  const area = page.getByRole('region', { name: '评论区', exact: true });
  const rows = directRows(area);
  await expect(rows).toHaveCount(20);
  await rows.first().getByRole('button', { name: '展开评论', exact: true }).click();
  const replies = page.getByRole('region', { name: '回复区 comment-44', exact: true });
  await replies.getByRole('listitem').first().getByRole('button', { name: '展开回复正文', exact: true }).click();
  await replies.getByRole('button', { name: '展开回复', exact: true }).click();
  await expect(replies.getByRole('listitem')).toHaveCount(13);
  await area.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(rows).toHaveCount(40);
  const anchor = replies.getByRole('listitem').nth(8);
  const text = await anchor.textContent();
  await locate(anchor);
  const offset = await position(anchor);
  // 不让“返回列表”按钮的自动滚动改变真正保存的阅读位置。
  await page.getByRole('button', { name: '返回列表', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect(listCard.getByRole('button', { name: '收起正文', exact: true })).toHaveCount(1);
  await expect.poll(() => position(listCard)).toBeCloseTo(40, 0);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goForward();
  await expect(rows).toHaveCount(40);
  await expect(replies.getByRole('listitem')).toHaveCount(13);
  await expect(rows.first().getByRole('button', { name: '收起评论', exact: true })).toHaveCount(1);
  await expect(replies.getByRole('listitem').first().getByRole('button', { name: '收起回复正文', exact: true })).toHaveCount(1);
  await expect(anchor).toContainText(text!);
  await expect(anchor).toBeInViewport();
  await expect.poll(async () => Math.abs(await position(anchor) - offset)).toBeLessThanOrEqual(2);
  await replies.getByRole('button', { name: '加载更多回复', exact: true }).click();
  await expect(replies.getByRole('listitem')).toHaveCount(23);
});

for (const target of ['same', 'other'] as const) {
  test(`${target}动态的新访问与旧访问快照隔离，历史导航不被主动入口抢占`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('article').first().getByRole('button', { name: '评论 70', exact: true }).click();
    const area = page.getByRole('region', { name: '评论区', exact: true });
    const rows = directRows(area);
    await expect(rows).toHaveCount(20);
    await area.getByRole('button', { name: '加载更多评论', exact: true }).click();
    const oldAnchor = rows.nth(25);
    await locate(oldAnchor);
    const oldText = await oldAnchor.textContent();
    // 通过标准浏览器地址导航创建新列表记录，保留两次访问的可达历史；不加产品入口。
    await page.evaluate(() => {
      history.pushState(null, '', '/');
      dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    await expect(page.getByRole('article')).toHaveCount(10);
    const card = page.getByRole('article').nth(target === 'same' ? 0 : 1);
    await card.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await area.getByRole('button', { name: '最新', exact: true }).click();
    if (target === 'same') {
      await expect(rows).toHaveCount(20);
      await locate(rows.nth(8));
    } else await expect(area.getByText('暂无评论')).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.goBack();
    await expect(rows).toHaveCount(40);
    await expect(area.getByRole('button', { name: '最热', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(oldAnchor).toContainText(oldText!);
    await expect(oldAnchor).toBeInViewport();
    await expect.poll(() => position(oldAnchor)).toBeCloseTo(40, 0);
    await area.getByRole('button', { name: '加载更多评论', exact: true }).click();
    await expect(rows).toHaveCount(45);
    await page.goForward();
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.goForward();
    await expect(area.getByRole('button', { name: '最新', exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (target === 'same') {
      await expect(rows).toHaveCount(20);
      await expect(rows.nth(8)).toBeInViewport();
      await expect.poll(() => position(rows.nth(8))).toBeCloseTo(40, 0);
    } else await expect(area.getByText('暂无评论')).toBeVisible();
  });
}

test('评论回复进度在图片预览后退/前进后保持，关闭焦点不覆盖位置且正常滚动', async ({ page }) => {
  await page.goto(`/dynamics/${firstId}`);
  const area = page.getByRole('region', { name: '评论区', exact: true });
  const rows = directRows(area);
  const replies = page.getByRole('region', { name: '回复区 comment-44', exact: true });
  await expect(replies.getByRole('listitem')).toHaveCount(3);
  await replies.getByRole('button', { name: '展开回复', exact: true }).click();
  await area.getByRole('button', { name: '加载更多评论', exact: true }).click();
  const anchor = replies.getByRole('listitem').nth(7);
  await locate(anchor);
  const trigger = page.getByRole('button', { name: '预览图片 1', exact: true });
  // 在原评论阅读位置打开已有图片按钮，不通过自动滚动更换底层位置。
  await trigger.evaluate(element => (element as HTMLButtonElement).click());
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(rows).toHaveCount(40);
  await expect(replies.getByRole('listitem')).toHaveCount(13);
  await expect(anchor).toBeInViewport();
  await expect.poll(() => position(anchor)).toBeCloseTo(40, 0);
  await page.goForward();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(anchor).toBeInViewport();
  await expect.poll(() => position(anchor)).toBeCloseTo(40, 0);
  const before = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 250);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before + 100);
});

test('慢图与未知尺寸不阻塞历史评论恢复；刷新重置内存且返回降级为列表', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let blocked = 0;
  await page.route('**/demo-images/*', async route => { blocked += 1; await held; await route.continue(); });
  try {
    await page.goto('/');
    await page.getByRole('article').first().getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    const area = page.getByRole('region', { name: '评论区', exact: true });
    const rows = directRows(area);
    await expect(rows).toHaveCount(20);
    const image = page.getByRole('article').getByRole('img', { name: '图片 1', exact: true });
    await expect(image).toHaveCount(1);
    await expect(image).not.toHaveAttribute('width');
    await expect.poll(() => blocked).toBeGreaterThan(0);
    await area.getByRole('button', { name: '加载更多评论', exact: true }).click();
    const anchor = rows.nth(22);
    await locate(anchor);
    await page.getByRole('button', { name: '返回列表', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(page).toHaveURL(/\/$/);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goForward();
    await expect(rows).toHaveCount(40);
    await expect(anchor).toBeInViewport();
    await expect.poll(() => position(anchor)).toBeCloseTo(40, 0);
    release();
    // 图像布局稳定：图片实际下载后不把已恢复的评论挤出视口。
    await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBeGreaterThan(0);
    await expect(anchor).toBeInViewport();
    await expect.poll(() => position(anchor)).toBeCloseTo(40, 0);
    await page.reload();
    await expect(rows).toHaveCount(20);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('article')).toHaveCount(10);
  } finally { release(); }
});

test('详情历史恢复未执行时，用户滚轮停止旧任务而不被迟到帧拉回', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('article').first().getByRole('link', { name: /^阅读全文 / }).evaluate(element => (element as HTMLAnchorElement).click());
  const area = page.getByRole('region', { name: '评论区', exact: true });
  const rows = directRows(area);
  await area.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await locate(rows.nth(25));
  await page.getByRole('button', { name: '返回列表', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.goForward();
  await expect(rows).toHaveCount(40);
  const wheelReceived = page.evaluate(() => new Promise<void>(resolve => window.addEventListener('wheel', () => resolve(), { once: true })));
  await page.mouse.wheel(0, 300);
  await wheelReceived;
  await page.clock.runFor(100);
  const afterUser = await page.evaluate(() => scrollY);
  expect(afterUser).toBeGreaterThan(0);
  expect(afterUser).toBeLessThan(1000);
  await page.clock.runFor(500);
  expect(await page.evaluate(() => scrollY)).toBe(afterUser);
});

test('稳定锚点缺失时使用有界像素后备，范围变短也有限结束', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('article').first().getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  const area = page.getByRole('region', { name: '评论区', exact: true });
  const rows = directRows(area);
  await area.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await locate(rows.nth(30));
  // 从 DOM 边界模拟保存的稳定标识不再可用，不读写内部会话或增加测试接口。
  await page.locator('main [data-reading-id]').evaluateAll(elements => {
    for (const element of elements) element.setAttribute('data-reading-id', `unavailable:${element.getAttribute('data-reading-id')}`);
  });
  await page.getByRole('button', { name: '返回列表', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(page).toHaveURL(/\/$/);
  await page.setViewportSize({ width: 1280, height: 20000 });
  await page.goForward();
  await expect(rows).toHaveCount(40);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(rows.last()).toBeInViewport();
  const before = await page.evaluate(() => scrollY);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => scrollY)).toBe(before);
});
