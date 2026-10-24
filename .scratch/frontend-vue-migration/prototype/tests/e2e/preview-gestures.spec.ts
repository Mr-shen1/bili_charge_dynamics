import { expect, test } from '@playwright/test';
import {
  canTouch, closeViewer, counter, dragImage, doubleTapImage, imageBox, navArrowVisibility, openImage, pinchImage,
  renderedImageBox, swipe, viewer, viewerImage, waitForStableViewer,
} from './support';

test.describe('窄屏手势（滑动切图）', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await canTouch(page)), '需要触摸环境；宽屏键鼠路径由其他用例覆盖');
    await page.goto('/');
    await openImage(page, 'many', 1);
    await expect(counter(page)).toHaveText('2 / 12');
  });

  test('窄屏隐藏切图箭头与图标工具栏，不提供文字关闭按钮', async ({ page }) => {
    expect(await navArrowVisibility(page)).toEqual({ prev: false, next: false });
    await expect(page.locator('.el-image-viewer__actions')).toBeHidden();
    await expect(page.getByRole('button', { name: '关闭预览' })).toHaveCount(0);
    await expect(page.locator('.el-image-viewer__close')).toBeVisible();
  });

  test('左右滑动切换图片', async ({ page }) => {
    await swipe(page, 'next');
    await expect(counter(page)).toHaveText('3 / 12');
    await swipe(page, 'next');
    await expect(counter(page)).toHaveText('4 / 12');
    await swipe(page, 'previous');
    await expect(counter(page)).toHaveText('3 / 12');
  });

  test('滑动到头后继续滑不前进、不环绕', async ({ page }) => {
    for (let step = 0; step < 12; step += 1) await swipe(page, 'next');
    await expect(counter(page)).toHaveText('12 / 12');
    for (let step = 0; step < 3; step += 1) await swipe(page, 'next');
    await expect(counter(page)).toHaveText('12 / 12');

    for (let step = 0; step < 20; step += 1) await swipe(page, 'previous');
    await expect(counter(page)).toHaveText('1 / 12');
    await swipe(page, 'previous');
    await expect(counter(page)).toHaveText('1 / 12');
  });
});

test.describe('窄屏双指缩放', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!(await canTouch(page)), '需要触摸环境');
    await page.goto('/');
    await openImage(page, 'long', 0);
  });

  test('双指只放大图片，不缩放页面', async ({ page }) => {
    const before = await renderedImageBox(page);
    await pinchImage(page, 2.5);
    await expect.poll(async () => (await renderedImageBox(page)).height).toBeGreaterThan(before.height * 1.3);
    // 页面本身没有被浏览器手势放大。
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });

  test('放大后可以缩回接近原始尺寸', async ({ page }) => {
    const before = await renderedImageBox(page);
    await pinchImage(page, 2.5);
    await expect.poll(async () => (await renderedImageBox(page)).height).toBeGreaterThan(before.height * 1.3);
    await pinchImage(page, 0.4);
    await expect.poll(async () => (await renderedImageBox(page)).height).toBeLessThan(before.height * 1.1);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });

  test('放大后单指拖动用于阅读，不触发切图', async ({ page }) => {
    await pinchImage(page, 2.5);
    const before = await counter(page).textContent();
    await swipe(page, 'next');
    await expect(counter(page)).toHaveText(before ?? '1 / 1');
  });

  test('未放大时图片不可拖动，但左右滑动仍能切图', async ({ page }) => {
    await waitForStableViewer(page);
    const before = await imageBox(page);
    await dragImage(page, 90, 120);
    const after = await imageBox(page);
    expect(after).toEqual(before);
    await expect(counter(page)).toHaveText('1 / 1');

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await openImage(page, 'many', 1);
    await waitForStableViewer(page);
    const manyBefore = await imageBox(page);
    await dragImage(page, 40, 60);
    expect(await imageBox(page)).toEqual(manyBefore);
    await swipe(page, 'next');
    await expect(counter(page)).toHaveText('3 / 12');
  });

  test('双击放大到固定倍率，再次双击回到原始比例并居中', async ({ page }) => {
    await waitForStableViewer(page);
    const before = await imageBox(page);
    await doubleTapImage(page);
    await expect.poll(async () => (await imageBox(page)).height).toBeGreaterThan(before.height * 2);

    await doubleTapImage(page);
    await expect.poll(async () => (await imageBox(page)).height).toBeLessThan(before.height * 1.05);
    const restored = await imageBox(page);
    const viewport = page.viewportSize() ?? { width: 390, height: 720 };
    // 双击还原必须同时清掉拖动产生的偏移，图片回到画面中心。
    expect(Math.abs(restored.centerX - viewport.width / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(restored.centerY - viewport.height / 2)).toBeLessThanOrEqual(2);
  });

  test('放大后拖动有效，双击还原会清掉拖动偏移', async ({ page }) => {
    await doubleTapImage(page);
    await expect.poll(async () => (await imageBox(page)).height).toBeGreaterThan(200);
    const zoomed = await imageBox(page);
    await dragImage(page, 0, -160);
    await expect.poll(async () => (await imageBox(page)).centerY).toBeLessThan(zoomed.centerY - 10);

    await doubleTapImage(page);
    const viewport = page.viewportSize() ?? { width: 390, height: 720 };
    await expect.poll(async () => {
      const box = await imageBox(page);
      return Math.abs(box.centerY - viewport.height / 2);
    }).toBeLessThanOrEqual(2);
  });

  test('关闭预览后不残留缩放，重新打开回到完整显示', async ({ page }) => {
    const before = await renderedImageBox(page);
    await pinchImage(page, 2.5);
    await expect.poll(async () => (await renderedImageBox(page)).height).toBeGreaterThan(before.height * 1.3);
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await openImage(page, 'long', 0);
    await expect.poll(async () => (await renderedImageBox(page)).height).toBeLessThanOrEqual(before.height + 2);
    await expect(viewerImage(page)).toBeVisible();
  });
});
