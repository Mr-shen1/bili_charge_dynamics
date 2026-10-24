// @projects desktop-chromium, mobile-chromium
import { expect, test, type Page } from '@playwright/test';
import {
  closeViewer, counter, historyLength, imageRequests, nextImage, pathsPrefixed, resetImageRequests, scrollY,
  viewer, viewerImage, viewerToolbar,
} from './support';

// mock 装配 25 条归档的稳定业务 ID，来自 src/mock/archiveReader.ts 的生成规则。
const ids = {
  quad: '90071992547409931',
  pure: '90071992547409932',
  nine: '90071992547409933',
  many: '90071992547409934',
  mixed: '90071992547409936',
  long: '90071992547409937',
};
const card = (page: Page, id: string) => page.locator(`article[data-reading-id="${id}"]`);

// mock 装配的真实页面：动态图片来自归档读取契约，缩略图与预览地址可区分，
// 完整组、异常状态与长图都由确定性夹具提供。jsdom 不能替代真实布局与请求。
test.describe('动态图片阅读', () => {
  test('列表展示 4/9/12 图组，超过九张时第九张进入完整组且索引正确', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(10);

    const quad = card(page, ids.quad);
    await expect(quad.getByRole('button', { name: /^预览动态图片 / })).toHaveCount(4);
    const nine = card(page, ids.nine);
    await expect(nine.getByRole('button', { name: /^预览动态图片 / })).toHaveCount(9);
    await expect(nine.getByText('+3')).toHaveCount(0);

    const many = card(page, ids.many);
    const tiles = many.getByRole('button', { name: /^预览动态图片 / });
    await expect(tiles).toHaveCount(9);
    await expect(many.getByText('+3')).toBeVisible();

    // 第九张属于 12 张完整组的索引 8；点击不冒泡成卡片导航。
    await tiles.nth(8).click();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('9 / 12');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '动态详情' })).toHaveCount(0);
  });

  test('详情展示完整图片组，点击第 11 张打开所点图片', async ({ page }) => {
    await page.goto('/');
    const many = card(page, ids.many);
    await many.getByRole('button', { name: '预览动态图片 1' }).scrollIntoViewIfNeeded();
    await many.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    await expect(page).toHaveURL(/\/dynamics\//);
    const detail = page.getByRole('article');
    // 详情不沿用列表的九张上限，完整组 12 张全部可达。
    await expect(detail.getByRole('button', { name: /^预览动态图片 / })).toHaveCount(12);
    await detail.evaluate(element => element.setAttribute('data-mount-probe', 'kept'));
    await detail.getByRole('button', { name: '预览动态图片 11' }).click();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('11 / 12');
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/dynamics\//);
    // 同 URL 预览不重挂载底层详情。
    await expect(detail).toHaveAttribute('data-mount-probe', 'kept');
  });

  test('关闭预览恢复触发焦点与滚动位置，重复开关不重置列表阅读状态', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const first = card(page, ids.quad);
    await first.getByRole('button', { name: '展开正文' }).click();
    const tile = first.getByRole('button', { name: '预览动态图片 1' });
    await tile.scrollIntoViewIfNeeded();
    const before = await scrollY(page);
    const tileId = await tile.getAttribute('id');
    const historyBase = await historyLength(page);
    await first.evaluate(element => element.setAttribute('data-mount-probe', 'kept'));

    await tile.focus();
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toBeVisible();
    expect(await historyLength(page)).toBe(historyBase + 1);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.el-image-viewer__wrapper'))).toBe(true);
    // 预览期间底层不滚动。
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(150);
    expect(await scrollY(page)).toBe(before);

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe(tileId);
    expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(2);
    // 同 URL 预览不重挂载列表，正文仍保持展开。
    await expect(first).toHaveAttribute('data-mount-probe', 'kept');
    await expect(first.getByRole('button', { name: '收起正文' })).toBeVisible();

    // 重复开关仍能关闭；切图不新增历史记录，再次打开替换前进记录而不多压一条。
    await tile.click();
    await expect(viewer(page)).toBeVisible();
    await nextImage(page);
    await expect(counter(page)).toHaveText('2 / 4');
    expect(await historyLength(page)).toBe(historyBase + 1);
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect(first).toHaveAttribute('data-mount-probe', 'kept');
  });

  test('浏览器后退优先关闭预览，前进恢复对应图片且不多退一级', async ({ page }) => {
    await page.goto('/ups/123');
    await expect(page.getByRole('heading', { name: 'UP 123 归档' })).toBeVisible();
    // 单 UP 只保留该作者的动态：范围内第三张对应 12 图组。
    const scopeCard = card(page, ids.many);
    const tile = scopeCard.getByRole('button', { name: '预览动态图片 3' });
    await tile.scrollIntoViewIfNeeded();
    const historyBefore = await historyLength(page);

    await tile.click();
    await expect(viewer(page)).toBeVisible();
    await nextImage(page);
    await expect(counter(page)).toHaveText('4 / 12');
    expect(await historyLength(page)).toBe(historyBefore + 1);

    await page.goBack();
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/ups\/123$/);
    await expect(page.getByRole('heading', { name: 'UP 123 归档' })).toBeVisible();

    await page.goForward();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('4 / 12');

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/ups\/123$/);
    expect(await historyLength(page)).toBe(historyBefore + 1);
  });

  test('异常图片区分未上传、归档失败、无效地址与加载失败，可跳过、关闭并局部重试', async ({ page }) => {
    await page.goto('/');
    // 无发布时间的动态排在末尾，混合状态组位于可见顺序第五张。
    const mixed = card(page, ids.mixed);
    const grid = mixed.locator(`[data-image-group="dynamic-${ids.mixed}"]`);
    await grid.scrollIntoViewIfNeeded();

    // 缩略图直接表达上传状态；无效地址不回退来源业务图。
    await expect(mixed.getByText('图片待归档')).toBeVisible();
    await expect(mixed.getByText('图片归档失败')).toBeVisible();
    await expect(mixed.getByText('归档图片地址不可用')).toBeVisible();
    const tiles = mixed.getByRole('button', { name: /^预览动态图片 / });
    await expect(tiles).toHaveCount(6);

    // 浏览器加载失败的缩略图才提供局部重试，重试只重发既有公开地址。
    await expect(mixed.getByRole('button', { name: '重试缩略图' })).toHaveCount(1);
    await resetImageRequests(page);
    await mixed.getByRole('button', { name: '重试缩略图' }).click();
    // 重试只重发该缩略图的既有公开地址，不重新采集或换来源。
    await expect.poll(async () => pathsPrefixed(await imageRequests(page), '/images/broken/archive-mixed-5.svg'))
      .toHaveLength(1);

    await resetImageRequests(page);
    await tiles.nth(1).click();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('2 / 6');
    await expect.poll(async () => viewerImage(page).getAttribute('src')).toBe('/images/unavailable/placeholder.svg');
    await expect(page.locator('.preview-note')).toContainText('图片待归档');

    await nextImage(page);
    await expect(counter(page)).toHaveText('3 / 6');
    await expect.poll(async () => viewerImage(page).getAttribute('src')).toBe('/images/unavailable/placeholder.svg');
    await expect(page.locator('.preview-note')).toContainText('图片归档失败');

    await nextImage(page);
    await expect(counter(page)).toHaveText('4 / 6');
    await expect(page.locator('.preview-note')).toContainText('归档图片地址不可用');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);

    await nextImage(page);
    await expect(counter(page)).toHaveText('5 / 6');
    await expect(page.locator('.preview-note')).toHaveCount(0);
    await expect(page.locator('.preview-error')).toContainText('图片加载失败');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();

    await nextImage(page);
    await expect(counter(page)).toHaveText('6 / 6');
    await expect(page.locator('.preview-error')).toContainText('图片加载失败');
    await expect.poll(async () => pathsPrefixed(await imageRequests(page), '/images/flaky/archive-mixed-6.svg')).toHaveLength(1);

    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('.preview-error')).toHaveCount(0);
    await expect(viewerImage(page)).toBeVisible();
    await expect.poll(async () => pathsPrefixed(await imageRequests(page), '/images/flaky/archive-mixed-6.svg')).toHaveLength(2);
    // 重试不改变所看图片，也不新增历史记录或触发来源采集。
    await expect(counter(page)).toHaveText('6 / 6');

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    const requests = await imageRequests(page);
    // 只有应用占位、无效缓存与公开夹具地址；不存在来源业务图请求。
    expect(requests.every(request => request.path.startsWith('/images/'))).toBe(true);
  });

  test('冷缓存下缩略图按可见性懒加载，打开预览只请求所点原图', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await resetImageRequests(page);
    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(10);
    await page.waitForTimeout(500);

    // 12 图组在首屏之外：页面打开时不铺开缩略图，更没有预览原图请求。
    const initial = await imageRequests(page);
    expect(pathsPrefixed(initial, '/images/thumb/archive-many-')).toEqual([]);
    expect(pathsPrefixed(initial, '/images/full/')).toEqual([]);

    const many = card(page, ids.many);
    await many.getByRole('button', { name: '预览动态图片 1' }).scrollIntoViewIfNeeded();
    // 滚动进入后只加载可见缩略图，数量受视口约束，不一次请求整组。
    await expect.poll(async () => pathsPrefixed(await imageRequests(page), '/images/thumb/archive-many-').length)
      .toBeGreaterThan(0);
    const loadedThumbs = pathsPrefixed(await imageRequests(page), '/images/thumb/archive-many-');
    expect(loadedThumbs.length).toBeLessThanOrEqual(9);
    expect(pathsPrefixed(await imageRequests(page), '/images/full/')).toEqual([]);

    await resetImageRequests(page);
    await many.getByRole('button', { name: '预览动态图片 5' }).click();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('5 / 12');
    await page.waitForTimeout(300);
    // 只请求所点图片的原图，不预下载整组；缩略图与预览地址可区分。
    expect(new Set(pathsPrefixed(await imageRequests(page), '/images/full/'))).toEqual(
      new Set(['/images/full/archive-many-5.svg']),
    );
  });

  test('长图与纯图动态可打开预览，图片按原比例展示并可关闭', async ({ page }) => {
    await page.goto('/');
    const pure = card(page, ids.pure);
    await expect(pure.getByRole('button', { name: /^预览动态图片 / })).toHaveCount(1);
    await expect(pure.getByText('暂无内容')).toHaveCount(0);

    // 无发布时间的一张排到末尾；长图夹具位于首批可见的第六张卡片（索引 5）。
    const long = card(page, ids.long);
    const tile = long.getByRole('button', { name: '预览动态图片 1' });
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('1 / 1');
    const natural = await viewerImage(page).evaluate(image => ({
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight,
    }));
    expect(natural).toEqual({ width: 1200, height: 6000 });

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });

  test('四视口图片网格不横溢、触控目标足够，预览焦点/滚动恢复且工具栏可达', async ({ page }) => {
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.getByRole('article')).toHaveCount(10);

      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(metrics.scrollWidth, `${width}px 页面不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth);

      const many = card(page, ids.many);
      const tiles = many.getByRole('button', { name: /^预览动态图片 / });
      const boxes = await tiles.evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        return { width: box.width, height: box.height };
      }));
      for (const box of boxes) {
        expect(box.width, `${width}px 缩略图宽度`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${width}px 缩略图高度`).toBeGreaterThanOrEqual(44);
      }

      await tiles.first().scrollIntoViewIfNeeded();
      const before = await scrollY(page);
      const tileId = await tiles.first().getAttribute('id');
      await tiles.first().click();
      await expect(viewer(page)).toBeVisible();
      // 窄屏隐藏库切图箭头与工具栏但仍可滑动/键盘关闭；宽屏保留库原生工具栏。
      if (width > 640) await expect(viewerToolbar(page)).toBeVisible();
      else await expect(viewerToolbar(page)).toBeHidden();
      await closeViewer(page);
      await expect(viewer(page)).toHaveCount(0);
      // 四视口都恢复触发焦点与滚动位置，不只桌面一档。
      await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe(tileId);
      expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(2);
    }
  });

  test('带图片与异常图片的详情返回仍恢复列表阅读位置', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const mixed = card(page, ids.mixed);
    await mixed.evaluate(element => {
      window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 40);
    });
    const offset = await mixed.evaluate(element => Math.round(element.getBoundingClientRect().top));

    await mixed.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    const detail = page.getByRole('article');
    await expect(detail.getByRole('button', { name: /^预览动态图片 / })).toHaveCount(6);
    await page.getByRole('button', { name: '返回列表' }).click();
    await expect(page.getByRole('article')).toHaveCount(10);
    await expect.poll(() => mixed.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);
  });

  test('历史前进跨详情重新挂载后仍恢复对应图片', async ({ page }) => {
    await page.goto('/');
    const many = card(page, ids.many);
    await many.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    const detail = page.getByRole('article');
    await expect(detail.getByRole('button', { name: /^预览动态图片 / })).toHaveCount(12);
    await detail.getByRole('button', { name: '预览动态图片 6' }).click();
    await expect(counter(page)).toHaveText('6 / 12');

    await page.goBack();
    await expect(viewer(page)).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(10);

    // 前进使详情重新挂载：会话内已读图片组仍能解析历史预览标记。
    await page.goForward();
    await expect(page).toHaveURL(/\/dynamics\//);
    await expect(page.getByRole('article').getByRole('button', { name: /^预览动态图片 / })).toHaveCount(12);
    await page.goForward();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('6 / 12');
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/dynamics\//);
  });

  test('触发缩略图已消失时关闭预览退到页面后备焦点', async ({ page }) => {
    await page.goto('/');
    const tile = card(page, ids.many).getByRole('button', { name: '预览动态图片 1' });
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await expect(viewer(page)).toBeVisible();

    await tile.evaluate(element => element.remove());
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    expect(await page.evaluate(
      () => document.activeElement?.hasAttribute('data-preview-fallback-focus') ?? false,
    )).toBe(true);
  });
});
