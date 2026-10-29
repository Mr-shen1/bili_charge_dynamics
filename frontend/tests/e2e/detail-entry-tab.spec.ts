// @projects desktop-chromium, mobile-chromium
import { expect, test, type Page } from '@playwright/test';
import { commentSort, scrollY } from './support';

// 桌面正文入口：真实浏览器标签页，不是 setWindowOpenHandler 或 open() 的 spy。
// 观察的是“点完以后用户看到什么”：新页面内容、标签标题、opener 隔离，以及原列表一点没动。
// mock 装配自带确定性夹具（首条动态 45 条一级评论、首个根评论 25 条回复），不依赖后端。

const firstDynamicId = '90071992547409931';

async function alignTop(card: ReturnType<Page['getByRole']>, offset: number): Promise<void> {
  await card.evaluate((element, value) => {
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - value);
  }, offset);
}

/** 新标签页的公共断言：对应动态、标签标题、无正常详情页头。 */
async function expectDetailTab(popup: Page, id: string): Promise<void> {
  await expect(popup).toHaveURL(new RegExp(`/dynamics/${id}$`));
  await expect(popup).toHaveTitle('动态详情');
  // opener 隔离：新标签拿不到原列表的窗口引用。
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(popup.getByRole('article')).toHaveCount(1);
  await expect(popup.locator(`[data-reading-id="dynamic:${id}"]`)).toBeVisible();
  // 正常桌面详情：没有“动态详情”页头，也没有“返回列表”；正文贴到页面顶部。
  await expect(popup.locator('.detail-title')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: '返回列表' })).toHaveCount(0);
  await expect(popup.getByRole('button', { name: '‹ 动态列表' })).toHaveCount(0);
  const top = await popup.locator('.detail-card').evaluate(element => Math.round(element.getBoundingClientRect().top));
  expect(top).toBeLessThan(40);
}

// 新标签的窗口尺寸由浏览器决定，移动项目里开出的标签仍是手机宽度，
// 因此宽屏新标签行为只在桌面项目里观察（窄屏行为由下面同文件的窄屏用例覆盖）。
test.describe('桌面标签页', () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', '桌面新标签只在桌面项目观察');
  });

  test('桌面正文入口打开新标签：正确动态、标题、opener 隔离、刷新可读，原列表与内联评论不动', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(10);

  // 先在第一张卡片下展开一级评论：新标签不得收起它，也不得重置成默认排序。
  const first = cards.first();
  await first.getByRole('button', { name: /^来源评论 / }).click();
  const region = first.getByRole('region', { name: '评论区' });
  // 只数一级评论本身：楼中楼预览也有 listitem，不能混进来。
  const roots = region.locator('ul[aria-label="一级评论"] > li');
  await expect(roots).toHaveCount(20);

  const anchor = cards.nth(5);
  await alignTop(anchor, 40);
  const offset = await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top));
  const beforeScroll = await scrollY(page);
  expect(beforeScroll).toBeGreaterThan(0);
  const id = await anchor.getAttribute('data-reading-id');
  const beforeUrl = page.url();

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    anchor.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } }),
  ]);
  await expectDetailTab(popup, id!);

  // 复制/刷新地址仍能读取同一动态，标题不因刷新丢失。
  await popup.reload();
  await expect(popup.getByRole('article')).toHaveCount(1);
  await expect(popup.locator(`[data-reading-id="dynamic:${id}"]`)).toBeVisible();
  await expect(popup).toHaveTitle('动态详情');

  // 原列表：URL、滚动位置与第一张卡片的内联评论仍展开在原来的排序上。
  await expect(page).toHaveURL(beforeUrl);
  await expect(cards).toHaveCount(10);
  expect(await scrollY(page)).toBe(beforeScroll);
  expect(await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);
  await expect(commentSort(region, 'latest')).toBeVisible();
  await expect(roots).toHaveCount(20);
});

  test('组合键与中键交给浏览器原生语义：应用不再额外开窗，也不会把本标签带走', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  // 记录应用自己发起的 window.open：组合键/中键必须一次都不发起。
  await page.addInitScript(() => {
    const state = { opened: [] as string[] };
    (window as unknown as { __appOpened: string[] }).__appOpened = state.opened;
    const original = window.open.bind(window);
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      state.opened.push(String(url));
      return original(url, target, features);
    }) as typeof window.open;
  });
  await page.goto('/');
  const link = page.getByRole('article').first().getByRole('link', { name: /^阅读全文 / });
  const popups: Page[] = [];
  page.on('popup', popup => { popups.push(popup); });
  const appOpened = async () => page.evaluate(() => (window as unknown as { __appOpened: string[] }).__appOpened.length);

  await link.click({ modifiers: ['Control'], position: { x: 8, y: 8 } });
  await page.waitForTimeout(300);
  expect(await appOpened()).toBe(0);
  // 原生行为最多开一个新标签：绝不出现“应用再开一次”的第二扇窗。
  expect(popups.length).toBeLessThanOrEqual(1);
  await expect(page).toHaveURL(/\/$/);

  for (const popup of popups) await popup.close();
  popups.length = 0;

  await link.click({ button: 'middle', position: { x: 8, y: 8 } });
  await page.waitForTimeout(300);
  expect(await appOpened()).toBe(0);
  expect(popups.length).toBeLessThanOrEqual(1);
  await expect(page).toHaveURL(/\/$/);
});

  test('精确入口与普通详情的标题、定位各按自身意图，不被新标签规则重写', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/dynamics/${firstDynamicId}`);
  await expect(page).toHaveTitle('动态详情');

  // 一级评论精确入口仍是同一张详情页：标题不变，评论区按定位展开并高亮目标。
  await page.goto(`/dynamics/${firstDynamicId}/comments/90071992547401001/locate`);
  await expect(page).toHaveTitle('动态详情');
  await expect(page.getByRole('region', { name: '评论区' })).toBeVisible();
  await expect(page.locator('[data-located="true"]')).toHaveCount(1);
  // 直达的精确入口也不改成本标签内的列表来源，仍不显示返回列表。
  await expect(page.getByRole('button', { name: '‹ 动态列表' })).toHaveCount(0);

  // 回复精确入口在宽屏详情内定位，标题为回复详情；会话页有自己的名称。
  await page.goto(`/dynamics/${firstDynamicId}/comments/90071992547401001/replies/90071992547401102/locate`);
  await expect(page).toHaveTitle('回复详情');
  await page.goto(`/dynamics/${firstDynamicId}/comments/90071992547401001/replies/90071992547401102/conversation`);
  await expect(page).toHaveTitle('会话列表');
  });
});

// ---- 手机（窄屏）语义：站内进入、只留 `‹ 动态列表`、无来源回全部动态 ----

test('手机正文进入详情顶部，`‹ 动态列表` 回到来源列表的 scope 与位置', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(10);
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(cards).toHaveCount(20);

  const anchor = cards.nth(5);
  await alignTop(anchor, 40);
  const offset = await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top));
  const id = await anchor.getAttribute('data-reading-id');
  expect(await scrollY(page)).toBeGreaterThan(0);

  await anchor.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(new RegExp(`/dynamics/${id}$`));
  // 正文入口从顶部开始；手机只保留一个返回控件，没有重复的“动态详情”页头。
  await expect.poll(() => scrollY(page)).toBe(0);
  await expect(page.locator('.detail-title')).toHaveCount(0);
  await expect(page.locator(`[data-reading-id="dynamic:${id}"]`)).toBeVisible();
  await expect(page.getByRole('button', { name: '‹ 动态列表' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '返回列表' })).toHaveCount(0);

  await page.getByRole('button', { name: '‹ 动态列表' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(cards).toHaveCount(20);
  await expect.poll(() => anchor.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);
});

test('手机单 UP 来源与评论按钮：返回同一 scope，评论入口定位一级评论区', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/ups/123');
  await expect(page.getByRole('heading', { name: 'UP 123 动态' })).toBeVisible();
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(10);

  // 评论按钮：当前标签进入详情并定位一级评论区。
  await cards.first().getByRole('button', { name: /^来源评论 / }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${firstDynamicId}$`));
  const region = page.getByRole('region', { name: '评论区' });
  await expect(region).toBeVisible();
  await expect.poll(async () => region.evaluate(element => Math.round(element.getBoundingClientRect().top)))
    .toBeLessThan(200);

  await page.getByRole('button', { name: '‹ 动态列表' }).click();
  await expect(page).toHaveURL(/\/ups\/123$/);
  await expect(page.getByRole('link', { name: '纸飞机' })).toHaveAttribute('aria-current', 'page');
  await expect(cards).toHaveCount(10);
});

test('手机直达与刷新失去来源时返回全部动态，不留在详情也不离站', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/dynamics/${firstDynamicId}`);
  await page.reload();
  await expect(page.getByRole('button', { name: '‹ 动态列表' })).toHaveCount(1);
  await page.getByRole('button', { name: '‹ 动态列表' }).click();
  await expect(page).toHaveURL(new RegExp('^http://127\\.0\\.0\\.1:\\d+/$'));
  await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();
  await expect(page.getByRole('article').first()).toBeVisible();

  // 无内容的地址仍保留必要恢复操作，不会把人困在详情页。
  await page.goto('/dynamics/123');
  await expect(page.getByText('动态不存在或不可用')).toBeVisible();
  await page.getByRole('button', { name: '‹ 动态列表' }).click();
  await expect(page).toHaveURL(new RegExp('^http://127\\.0\\.0\\.1:\\d+/$'));
});

// ---- 四宽度：正常详情页头与横向溢出 ----

test('四宽度正常详情页头正确且不横向溢出', async ({ page }) => {
  for (const width of [360, 390, 768, 1280]) {
    const compact = width <= 640;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/dynamics/${firstDynamicId}`);
    await expect(page.locator('.detail-card')).toBeVisible();
    // 两端都不再有“动态详情”页头；窄屏只留一个 `‹ 动态列表`，宽屏没有返回控件。
    await expect(page.locator('.detail-title')).toHaveCount(0);
    if (compact) {
      await expect(page.getByRole('button', { name: '‹ 动态列表' })).toHaveCount(1);
      const height = await page.locator('.detail-back').evaluate(element => element.getBoundingClientRect().height);
      expect(height, `${width}px 返回控件点击区`).toBeGreaterThanOrEqual(44);
    } else {
      await expect(page.getByRole('button', { name: '‹ 动态列表' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '返回列表' })).toHaveCount(0);
      const top = await page.locator('.detail-card').evaluate(element => Math.round(element.getBoundingClientRect().top));
      expect(top, `${width}px 正文贴顶`).toBeLessThan(40);
    }
    await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth + 1), { message: `${width}px 无横向溢出` }).toBe(true);
  }
});
