import { expect, test, type Locator } from '@playwright/test';
import { installNavigationHttp } from './fixtures/navigation-http';

const position = (anchor: Locator) => anchor.evaluate(element => element.getBoundingClientRect().top);
const locate = (anchor: Locator) => anchor.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 40));
const clickWithoutScroll = (link: Locator) => link.evaluate(element => (element as HTMLAnchorElement).click());

test('生产 Adapter HTTP：四宽度选择条局部横滑，跨 scope 同动态访问恢复各自多批、展开与位置', async ({ page }) => {
  await installNavigationHttp(page);
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: '归档范围', exact: true });
  const all = navigation.getByRole('link', { name: '全部归档', exact: true });
  const author = navigation.getByRole('link', { name: '虚构作者一', exact: true });
  const unknown = navigation.getByRole('link', { name: '未知用户', exact: true });
  await expect(navigation.getByRole('link')).toHaveCount(21);
  await expect(all).toHaveAttribute('aria-current', 'page');
  await expect(author.locator('img')).toHaveAttribute('src', 'https://example.invalid/navigation-avatar.svg');
  await expect(unknown.locator('img')).toHaveAttribute('src', '/default-avatar.svg');
  await expect(unknown).toHaveAttribute('href', '/ups/456');

  // 同一次用户流程随宽度重排，不另行批量生成想象中的测试。
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await navigation.scrollIntoViewIfNeeded();
    // 在公开 DOM 中找到选择条的可横滑容器；不绑定 CSS module 或内部 class。
    await navigation.evaluate(element => {
      const port = [element, ...element.querySelectorAll<HTMLElement>('*')].find(candidate =>
        ['auto', 'scroll'].includes(getComputedStyle(candidate).overflowX) && candidate.scrollWidth > candidate.clientWidth);
      if (!port) throw new Error('UP navigation must have a local horizontal scroll area');
      port.scrollLeft = 0;
    });
    const before = await all.evaluate(element => element.getBoundingClientRect().left);
    const box = (await navigation.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(400, 0);
    await expect.poll(() => all.evaluate(element => element.getBoundingClientRect().left)).toBeLessThan(before - 100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => scrollX)).toBe(0);
    // 键盘聚焦把屏幕外选项滚入条内；不滚宽整页。
    const last = navigation.getByRole('link').last();
    await page.keyboard.press('Tab');
    await last.focus();
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    expect(await last.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await expect(page.getByRole('article')).toHaveCount(10);
  const first = page.getByRole('article').first();
  await first.getByRole('button', { name: '展开正文', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  const shared = page.getByRole('article').filter({ has: page.getByRole('link', { name: '阅读全文 1013', exact: true }) });
  await locate(shared);
  const allOffset = await position(shared);
  await clickWithoutScroll(shared.getByRole('link', { name: '阅读全文 1013', exact: true }));
  await expect(page).toHaveURL(/\/dynamics\/1013$/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect(first.getByRole('button', { name: '收起正文', exact: true })).toHaveCount(1);
  await expect.poll(() => position(shared)).toBeCloseTo(allOffset, 0);

  await clickWithoutScroll(author);
  await expect(page).toHaveURL(/\/ups\/123$/);
  await expect(author).toHaveAttribute('aria-current', 'page');
  await expect(all).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('article')).toHaveCount(10);
  // 同一条动态在单 UP 新访问中不能借用全部列表的展开快照。
  await expect(first.getByRole('button', { name: '展开正文', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(13);
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);
  await locate(shared);
  const upOffset = await position(shared);
  await clickWithoutScroll(shared.getByRole('link', { name: '阅读全文 1013', exact: true }));
  await expect(page).toHaveURL(/\/dynamics\/1013$/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page).toHaveURL(/\/ups\/123$/);
  await expect(page.getByRole('article')).toHaveCount(13);
  await expect(first.getByRole('button', { name: '展开正文', exact: true })).toHaveCount(1);
  await expect.poll(() => position(shared)).toBeCloseTo(upOffset, 0);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(all).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect(first.getByRole('button', { name: '收起正文', exact: true })).toHaveCount(1);
  await expect.poll(() => position(shared)).toBeCloseTo(allOffset, 0);
  await page.goForward();
  await expect(page).toHaveURL(/\/ups\/123$/);
  await expect(page.getByRole('article')).toHaveCount(13);
  await expect(first.getByRole('button', { name: '展开正文', exact: true })).toHaveCount(1);
  await expect.poll(() => position(shared)).toBeCloseTo(upOffset, 0);
  await page.goBack();
  await expect(page.getByRole('article')).toHaveCount(20);
  // HTTP fixture 拒绝跨 scope cursor；恢复全部访问后必须继续自己的第三批。
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(25);
  await expect(page.getByText('动态已加载完毕', { exact: true })).toBeVisible();
  expect(await page.getByRole('article').evaluateAll(cards => cards.map(card => card.getAttribute('data-reading-id')))).toEqual([
    '1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009', '1010',
    '1011', '1012', '1013', '1014', '1015', '1016', '1017', '1018', '1019', '1020',
    '1021', '1022', '1023', '1024', '1025',
  ]);
});
