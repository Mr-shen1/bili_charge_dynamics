// @projects desktop-chromium, mobile-chromium
import { expect, test, type Page } from '@playwright/test';
import {
  closeViewer, counter, focusInsideViewer, historyLength, imageRequests, nextImage, pathsPrefixed,
  commentSort, previewState, resetImageRequests, scrollY, switchCommentSort, viewer, viewerClose, viewerImage,
  viewerToolbar,
} from './support';

// mock 装配 25 条归档与 45 条一级评论的稳定业务 ID，来自 src/mock/archiveReader.ts 的生成规则。
const dynamicId = '90071992547409931';
const commentId = (index: number) => `900719925474010${String(1 + index).padStart(2, '0')}`;
const imageGroup = (id: string) => `comment-${id}`;
const commentItem = (page: Page, index: number) => page.locator(`[data-reading-id="comment:${commentId(index)}"]`);

// 回复区也是列表项：评论只按根评论的稳定阅读标识计数，不把回复算进来。
const commentItems = (page: Page) => page.locator('[data-reading-id^="comment:"]');

async function openDetail(page: Page): Promise<void> {
  await page.goto(`/dynamics/${dynamicId}`);
  await expect(commentItems(page)).toHaveCount(20);
}

// 评论图片来自归档读取契约；缩略图与预览地址可区分，异常、长图与超量组由确定性夹具提供。
test.describe('一级评论图片阅读', () => {
  test('混合状态组：缩略占位区分未上传/归档失败/无效地址/加载失败，可跳过、关闭并局部重试', async ({ page }) => {
    await openDetail(page);
    const mixed = commentItem(page, 0).locator(`[data-image-group="${imageGroup(commentId(0))}"]`);
    await mixed.scrollIntoViewIfNeeded();
    await expect(mixed).toHaveCount(1);

    await expect(mixed.getByText('图片待保存')).toBeVisible();
    await expect(mixed.getByText('图片保存失败')).toBeVisible();
    await expect(mixed.getByText('已保存图片地址不可用')).toBeVisible();
    const tiles = mixed.getByRole('button', { name: /^预览评论图片 / });
    await expect(tiles).toHaveCount(6);
    // 只有浏览器加载失败的缩略图提供局部重试。
    await expect(mixed.getByRole('button', { name: '重试缩略图' })).toHaveCount(1);

    await resetImageRequests(page);
    await mixed.getByRole('button', { name: '重试缩略图' }).click();
    await expect.poll(async () => pathsPrefixed(await imageRequests(page), '/images/broken/comment-mixed-5.svg'))
      .toHaveLength(1);

    await resetImageRequests(page);
    await tiles.nth(1).click();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('2 / 6');
    await expect.poll(async () => viewerImage(page).getAttribute('src')).toBe('/images/unavailable/placeholder.svg');
    await expect(page.locator('.preview-note')).toContainText('图片待保存');

    // 异常图片不阻断切换：逐项切到失败、无效、浏览器失败与可重试项。
    await nextImage(page);
    await expect(counter(page)).toHaveText('3 / 6');
    await expect(page.locator('.preview-note')).toContainText('图片保存失败');
    await nextImage(page);
    await expect(counter(page)).toHaveText('4 / 6');
    await expect(page.locator('.preview-note')).toContainText('已保存图片地址不可用');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);
    await nextImage(page);
    await expect(counter(page)).toHaveText('5 / 6');
    await expect(page.locator('.preview-error')).toContainText('图片加载失败');
    await nextImage(page);
    await expect(counter(page)).toHaveText('6 / 6');
    await expect(page.locator('.preview-error')).toContainText('图片加载失败');
    await expect.poll(async () => pathsPrefixed(await imageRequests(page), '/images/flaky/comment-mixed-6.svg'))
      .toHaveLength(1);
    // 重试只重发既有公开地址，不重新采集、不换来源。
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('.preview-error')).toHaveCount(0);
    await expect.poll(async () => pathsPrefixed(await imageRequests(page), '/images/flaky/comment-mixed-6.svg'))
      .toHaveLength(2);
    await expect(counter(page)).toHaveText('6 / 6');

    // 按钮关闭与 Escape 都要能关掉预览。
    await viewerClose(page).click();
    await expect(viewer(page)).toHaveCount(0);
    // 无来源业务图请求：所有图片请求都落在应用自有夹具地址上。
    expect((await imageRequests(page)).every(request => request.path.startsWith('/images/'))).toBe(true);
  });

  test('纯图、单张长图与超过九张的评论组各自完整可达，索引与 owner 正确', async ({ page }) => {
    await openDetail(page);
    const region = page.getByRole('region', { name: '评论区' });

    // 纯图评论展示图片，且不伪装成"暂无评论内容"。
    const pure = commentItem(page, 2);
    await expect(pure.getByRole('group', { name: '评论图片' })).toHaveAttribute(
      'data-image-group', imageGroup(commentId(2)));
    await expect(pure.getByRole('button', { name: /^预览评论图片 / })).toHaveCount(4);
    await expect(pure.getByText('暂无评论内容')).toHaveCount(0);

    // 单张长图按原比例展示，可在预览中完整查看。
    const long = commentItem(page, 1);
    const longTile = long.getByRole('button', { name: '预览评论图片 1' });
    await longTile.scrollIntoViewIfNeeded();
    await longTile.click();
    await expect(counter(page)).toHaveText('1 / 1');
    expect(await viewerImage(page).evaluate(image => ({
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight,
    }))).toEqual({ width: 1200, height: 6000 });
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);

    // 12 图评论在默认按时间的首批内：展示前九张，末张进入完整组且索引正确。
    await expect(region).toHaveCount(1);
    await expect(commentItems(page)).toHaveCount(20);
    const many = commentItem(page, 5);
    const tiles = many.getByRole('button', { name: /^预览评论图片 / });
    await expect(tiles).toHaveCount(9);
    await expect(many.getByText('+3')).toBeVisible();
    await tiles.nth(8).scrollIntoViewIfNeeded();
    await tiles.nth(8).click();
    await expect(counter(page)).toHaveText('9 / 12');
    // 预览记录绑定该根评论的组，不落到动态或其他评论。
    expect((await previewState(page))?.groupId).toBe(imageGroup(commentId(5)));
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
  });

  test('同 URL 打开不重挂载、切图不新增历史，关闭恢复焦点/滚动且不重置排序与展开', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openDetail(page);
    const region = page.getByRole('region', { name: '评论区' });
    const detail = page.getByRole('article');
    await detail.evaluate(element => element.setAttribute('data-mount-probe', 'kept'));
    await region.evaluate(element => element.setAttribute('data-mount-probe', 'kept'));

    // 先把评论正文展开：预览不能把这些阅读状态重置。
    await expect(commentItems(page)).toHaveCount(20);
    await commentItem(page, 0).getByRole('button', { name: '展开评论' }).click();
    await expect(commentItem(page, 0).getByRole('button', { name: '收起评论' })).toBeVisible();

    const tile = commentItem(page, 2).getByRole('button', { name: '预览评论图片 1' });
    await tile.scrollIntoViewIfNeeded();
    const before = await scrollY(page);
    const tileId = await tile.getAttribute('id');
    const historyBase = await historyLength(page);

    await tile.focus();
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toBeVisible();
    expect(await historyLength(page)).toBe(historyBase + 1);
    // 焦点留在预览内，底层页面不滚动。
    expect(await focusInsideViewer(page)).toBe(true);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(150);
    expect(await scrollY(page)).toBe(before);

    await nextImage(page);
    await expect(counter(page)).toHaveText('2 / 4');
    // 切图只替换同一条记录的索引。
    expect(await historyLength(page)).toBe(historyBase + 1);

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe(tileId);
    expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(2);
    // 同 URL 预览不重挂载评论列表，排序、批次与正文展开都保持。
    await expect(region).toHaveAttribute('data-mount-probe', 'kept');
    await expect(detail).toHaveAttribute('data-mount-probe', 'kept');
    await expect(commentSort(region, 'latest')).toBeVisible();
    await expect(commentItem(page, 0).getByRole('button', { name: '收起评论' })).toBeVisible();

    // 后退优先关闭预览且不多退一级，前进恢复所看图片。
    await tile.click();
    await expect(viewer(page)).toBeVisible();
    await nextImage(page);
    await expect(counter(page)).toHaveText('2 / 4');
    await page.goBack();
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
    await page.goForward();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('2 / 4');
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);

    // 排序切换让缩略图节点真正重建：前进恢复预览后关闭，仍按稳定 ID 找回新节点。
    await switchCommentSort(region);
    await expect(commentSort(region, 'hot')).toBeVisible();
    await expect(commentItems(page)).toHaveCount(20);
    await page.goForward();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('2 / 4');
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe(tileId);
  });

  test('排序后原触发缩略图消失时，关闭预览退到页面后备焦点', async ({ page }) => {
    await openDetail(page);
    const region = page.getByRole('region', { name: '评论区' });
    // 12 图评论在默认按时间的首批内：切到按热度后它的缩略图会从页面消失。
    await expect(commentSort(region, 'latest')).toBeVisible();
    const many = commentItem(page, 5);
    const tile = many.getByRole('button', { name: '预览评论图片 3' });
    await tile.scrollIntoViewIfNeeded();
    await tile.click();
    await expect(counter(page)).toHaveText('3 / 12');

    await page.goBack();
    await expect(viewer(page)).toHaveCount(0);
    await switchCommentSort(region);
    await expect(commentSort(region, 'hot')).toBeVisible();
    await expect(commentItems(page)).toHaveCount(20);
    await expect(page.locator(`[data-image-group="${imageGroup(commentId(5))}"]`)).toHaveCount(0);

    // 前进恢复该预览；此时触发节点已不存在，关闭必须落到合理后备位置。
    await page.goForward();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('3 / 12');
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    expect(await page.evaluate(
      () => document.activeElement?.hasAttribute('data-preview-fallback-focus') ?? false,
    )).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
  });

  test('四视口评论图片不横溢、触控目标足够，预览焦点/滚动恢复且工具栏可达', async ({ page }) => {
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await openDetail(page);
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(metrics.scrollWidth, `${width}px 页面不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth);

      const tiles = commentItem(page, 0).getByRole('button', { name: /^预览评论图片 / });
      await tiles.first().scrollIntoViewIfNeeded();
      for (const box of await tiles.evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }))) {
        expect(box.width, `${width}px 缩略图宽度`).toBeGreaterThanOrEqual(44);
        expect(box.height, `${width}px 缩略图高度`).toBeGreaterThanOrEqual(44);
      }

      const before = await scrollY(page);
      const tileId = await tiles.first().getAttribute('id');
      await tiles.first().click();
      await expect(viewer(page)).toBeVisible();
      if (width > 640) await expect(viewerToolbar(page)).toBeVisible();
      else await expect(viewerToolbar(page)).toBeHidden();
      await closeViewer(page);
      await expect(viewer(page)).toHaveCount(0);
      await expect.poll(async () => page.evaluate(() => document.activeElement?.id)).toBe(tileId);
      expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(2);
    }
  });

  test('冷缓存下评论缩略图按可见性懒加载，打开预览只请求所点原图', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await resetImageRequests(page);
    await openDetail(page);
    await page.waitForTimeout(400);

    // 纯图评论的四张全是可用图片（缩略与预览地址可区分），整组预取会立刻暴露。
    const quad = commentItem(page, 2).locator(`[data-image-group="${imageGroup(commentId(2))}"]`);
    // 评论区在首屏之外：页面打开时不铺开缩略图，也没有任何预览原图请求。
    const initial = await imageRequests(page);
    expect(pathsPrefixed(initial, '/images/thumb/comment-quad-')).toEqual([]);
    expect(pathsPrefixed(initial, '/images/full/')).toEqual([]);

    await quad.scrollIntoViewIfNeeded();
    await expect.poll(async () => pathsPrefixed(await imageRequests(page), '/images/thumb/comment-quad-').length)
      .toBeGreaterThan(0);
    expect(pathsPrefixed(await imageRequests(page), '/images/full/')).toEqual([]);

    await resetImageRequests(page);
    await quad.getByRole('button', { name: '预览评论图片 3' }).click();
    await expect(viewer(page)).toBeVisible();
    await page.waitForTimeout(300);
    // 只请求所点图片的原图，不预下载整组其他图片。
    expect(new Set(pathsPrefixed(await imageRequests(page), '/images/full/'))).toEqual(
      new Set(['/images/full/comment-quad-3.svg']),
    );
  });
});
