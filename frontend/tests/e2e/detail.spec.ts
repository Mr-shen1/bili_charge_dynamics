import { expect, test, type Page } from '@playwright/test';

// 详情与阅读恢复跑 mock 装配的真实浏览器行为：确定性 25 条归档，不依赖后端。
// 滚动、锚点、历史与布局都由浏览器真实执行，jsdom 无法替代。

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY));
}

async function scrollWindowTo(page: Page, top: number): Promise<number> {
  return page.evaluate(value => { window.scrollTo(0, value); return Math.round(window.scrollY); }, top);
}

async function alignTop(card: ReturnType<Page['getByRole']>, offset: number): Promise<void> {
  await card.evaluate((element, value) => {
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - value);
  }, offset);
}

test.describe('动态详情与阅读恢复', () => {
  test('卡片进入详情顶部并全文展示，返回恢复来源列表的批次、展开与锚点', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const cards = page.getByRole('article');
    await expect(cards).toHaveCount(10);
    await cards.first().getByRole('button', { name: '展开正文' }).click();
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(cards).toHaveCount(20);

    const anchor = cards.nth(5);
    await alignTop(anchor, 40);
    const offset = await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top));
    const id = await anchor.getAttribute('data-reading-id');

    await anchor.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(new RegExp(`/dynamics/${id}$`));
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    // 主动入口从顶部开始，且详情正文不再折叠。
    await expect.poll(() => scrollY(page)).toBe(0);
    await expect(page.getByRole('article')).toHaveCount(1);
    await expect(page.getByRole('article').getByRole('button', { name: '展开正文' })).toHaveCount(0);

    // 返回时布局宽度变化，仍按稳定锚点恢复视口偏移。
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole('button', { name: '返回列表' }).click();
    await expect(cards).toHaveCount(20);
    await expect(cards.first().getByRole('button', { name: '收起正文' })).toHaveCount(1);
    await expect.poll(() => anchor.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);

    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(cards).toHaveCount(25);
    await expect(page.getByText('动态已加载完毕')).toBeVisible();
  });

  test('单 UP 来源返回对应范围列表，不跳到全部归档', async ({ page }) => {
    await page.goto('/ups/123');
    await expect(page.getByRole('heading', { name: 'UP 123 归档' })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.getByRole('button', { name: '加载更多' }).click();
    const loaded = await page.getByRole('article').count();
    expect(loaded).toBeGreaterThan(10);

    await page.getByRole('article').nth(3).getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await page.getByRole('button', { name: '返回列表' }).click();
    await expect(page).toHaveURL(/\/ups\/123$/);
    await expect(page.getByRole('heading', { name: 'UP 123 归档' })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(loaded);
    await expect(page.getByRole('link', { name: '纸飞机' })).toHaveAttribute('aria-current', 'page');
  });

  test('浏览器后退同样恢复列表；主题链接进入新列表不沿用旧详情位置', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(20);
    const anchor = page.getByRole('article').nth(7);
    await alignTop(anchor, 30);
    const offset = await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top));

    await anchor.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(20);
    await expect.poll(() => anchor.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);

    // 再次主动进入同一动态是新的访问，从顶部而不是上次位置开始。
    const detail = anchor.getByRole('link', { name: /^阅读全文 / });
    await detail.click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await scrollWindowTo(page, 160);
    // 用 DOM 点击避免浏览器把主题链接滚进视口，那会改变离开详情时保存的位置。
    await page.getByRole('link', { name: '归档', exact: true }).evaluate(element => (element as HTMLElement).click());
    await expect(page).toHaveURL(/\/$/);
    // 主题入口是同地址的新访问：从首批与顶部开始，不继承旧列表的 20 条与位置。
    await expect(page.getByRole('article')).toHaveCount(10);
    await expect.poll(() => scrollY(page)).toBe(0);
    await page.getByRole('article').nth(7).getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect.poll(() => scrollY(page)).toBe(0);

    // 一路后退：新列表仍只有自己的 10 条，最早那次列表访问仍是 20 条与原偏移。
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.goBack();
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(20);
    await expect.poll(() => anchor.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);
  });

  test('同一动态多次访问各自保存位置，后退与前进互不覆盖', async ({ page }) => {
    // 视口压到内容高度以下，保证详情确实可滚动；位置差异仍由真实浏览器历史恢复。
    await page.setViewportSize({ width: 390, height: 320 });
    await page.goto('/');
    const card = page.getByRole('article').nth(2);
    const link = card.getByRole('link', { name: /^阅读全文 / });
    await expect(card).toContainText('长词');

    await link.click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    const first = await scrollWindowTo(page, 300);
    expect(first).toBeGreaterThan(40);

    // 主题链接进入新列表访问，保留第一次详情访问在历史记录中。
    // 用 DOM 点击避免浏览器把主题链接滚进视口，那会把离开位置记成 0。
    await page.getByRole('link', { name: '归档', exact: true }).evaluate(element => (element as HTMLElement).click());
    await expect(page.getByRole('article').first()).toBeVisible();
    await page.getByRole('article').nth(2).getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    const second = await scrollWindowTo(page, Math.floor(first / 2));
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);

    await page.goBack();
    await page.goBack();
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect.poll(() => scrollY(page)).toBe(first);

    await page.goForward();
    await page.goForward();
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect.poll(() => scrollY(page)).toBe(second);
  });

  test('恢复尚未执行时用户滚动优先，迟到帧不再把人拉回旧位置', async ({ page }) => {
    await page.clock.install();
    await page.goto('/');
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(20);
    const anchor = page.getByRole('article').nth(12);
    await anchor.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect.poll(() => scrollY(page)).toBe(0);

    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
    await page.getByRole('button', { name: '返回列表' }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(page.getByRole('article')).toHaveCount(20);
    const wheelReceived = page.evaluate(() => new Promise<void>(resolve => {
      window.addEventListener('wheel', () => resolve(), { once: true });
    }));
    await page.mouse.wheel(0, 300);
    await wheelReceived;
    await page.clock.runFor(100);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(0);
    const afterUser = await scrollY(page);
    await page.clock.runFor(600);
    expect(await scrollY(page)).toBe(afterUser);
  });

  test('详情直达与刷新重新读取，不存在与失败分别表达', async ({ page }) => {
    const first = '90071992547409931';
    await page.goto(`/dynamics/${first}`);
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect(page.getByRole('article')).toContainText('今天把小小的想法写在这里');
    await page.reload();
    await expect(page.getByRole('article')).toContainText('今天把小小的想法写在这里');

    await page.goto('/dynamics/123');
    await expect(page.getByText('动态不存在或不可用')).toBeVisible();
    await expect(page.getByRole('button', { name: '重试' })).toHaveCount(0);
    await page.getByRole('button', { name: '返回列表' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();
  });
});
