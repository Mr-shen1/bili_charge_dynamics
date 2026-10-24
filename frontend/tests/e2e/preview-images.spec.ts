// @projects desktop-chromium, mobile-chromium
import { expect, test } from '@playwright/test';
import {
  closeViewer, counter, imageRequests, nextImage, openImage, pathsPrefixed, previousImage, resetImageRequests,
  viewer, viewerImage,
} from './support';

test.describe('图片组、异常与资源请求', () => {
  test('打开单张只请求所点原图，不预下载整组', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    await resetImageRequests(page);
    await openImage(page, 'many', 4);
    await expect(counter(page)).toHaveText('5 / 12');
    await expect(viewerImage(page)).toBeVisible();
    await page.waitForTimeout(400);

    // 只约束“没有加载整组原图”，不约束同一地址的请求次数上限。
    const requests = await imageRequests(page);
    expect(new Set(pathsPrefixed(requests, '/images/full/many-'))).toEqual(new Set(['/images/full/many-5.svg']));
    // 缩略图可以按可见性加载，但不能因为打开预览而整组加载原图。
    expect(pathsPrefixed(requests, '/images/thumb/many-').length).toBeLessThan(12);
  });

  test('异常混合组保留顺序与所点索引，仍可切换和关闭', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    await openImage(page, 'mixed', 1);
    await expect(counter(page)).toHaveText('2 / 5');
    await expect(page.locator('.preview-error')).toContainText('图片加载失败');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();

    await nextImage(page);
    await expect(counter(page)).toHaveText('3 / 5');
    await expect
      .poll(async () => viewerImage(page).getAttribute('src'))
      .toBe('/images/unavailable/placeholder.svg');

    await nextImage(page);
    await expect(counter(page)).toHaveText('4 / 5');
    await expect(page.locator('.preview-error')).toContainText('归档图片地址不可用');
    await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0);

    await nextImage(page);
    await expect(counter(page)).toHaveText('5 / 5');
    await expect(page.locator('.preview-error')).toContainText('图片加载失败');

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
  });

  test('浏览器加载失败可局部重试，重试只重发该图片地址', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    await resetImageRequests(page);
    await openImage(page, 'mixed', 4);
    await expect(page.locator('.preview-error')).toBeVisible();
    expect(pathsPrefixed(await imageRequests(page), '/images/flaky/mixed-5.svg')).toHaveLength(1);

    await page.getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('.preview-error')).toHaveCount(0);
    await expect(viewerImage(page)).toBeVisible();
    expect(pathsPrefixed(await imageRequests(page), '/images/flaky/mixed-5.svg')).toHaveLength(2);
    // 重试不改变当前图片与索引，也不新增历史记录。
    await expect(counter(page)).toHaveText('5 / 5');
  });

  test('未上传组使用应用占位，不请求来源业务图', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    await resetImageRequests(page);
    await openImage(page, 'no-url', 0);
    await expect(counter(page)).toHaveText('1 / 2');
    await expect
      .poll(async () => viewerImage(page).getAttribute('src'))
      .toBe('/images/unavailable/placeholder.svg');

    await nextImage(page);
    await expect(counter(page)).toHaveText('2 / 2');
    await expect
      .poll(async () => viewerImage(page).getAttribute('src'))
      .toBe('/images/unavailable/placeholder.svg');
    const requests = await imageRequests(page);
    expect(pathsPrefixed(requests, '/images/full/no-url-')).toEqual([]);
  });

  test('不同 owner 的图片组互不串入', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    await openImage(page, 'comment-a', 1);
    await expect(counter(page)).toHaveText('2 / 2');
    await page.waitForTimeout(300);
    const requests = await imageRequests(page);
    expect(new Set(pathsPrefixed(requests, '/images/full/comment-a-'))).toEqual(new Set(['/images/full/comment-a-2.svg']));
    expect(pathsPrefixed(requests, '/images/full/comment-b-')).toEqual([]);

    // 末张不再向后环绕；退回上一张只加载该组自己的图片。
    await nextImage(page);
    await expect(counter(page)).toHaveText('2 / 2');
    await previousImage(page);
    await expect(counter(page)).toHaveText('1 / 2');
    await page.waitForTimeout(300);
    expect(new Set(pathsPrefixed(await imageRequests(page), '/images/full/comment-a-'))).toEqual(new Set([
      '/images/full/comment-a-2.svg', '/images/full/comment-a-1.svg',
    ]));
  });

  test('生产共用缩略/预览地址时，打开也只请求所点地址', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    const sharedSection = page.locator('[data-group="shared"]');
    await sharedSection.scrollIntoViewIfNeeded();
    await expect(page.locator('#preview-trigger-shared-0 img')).toHaveCount(1);
    await resetImageRequests(page);
    await openImage(page, 'shared', 0);
    await page.waitForTimeout(400);
    const requests = pathsPrefixed(await imageRequests(page), '/images/full/shared-');
    // 共用地址无法区分尺寸变体；能验证的是打开时没有额外请求整组其它成员。
    expect(new Set(requests)).toEqual(new Set(['/images/full/shared-1.svg']));
  });

  test('只挂载一个预览实例与一张预览图', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    await openImage(page, 'quad', 0);
    expect(await viewer(page).count()).toBe(1);
    expect(await viewerImage(page).count()).toBe(1);
    await expect(page.getByRole('button', { name: '关闭预览' })).toHaveCount(0);
  });

  test('缩略图只显示前 9 张时，完整图片组仍可访问', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    const manySection = page.locator('[data-group="many"]');
    await expect(manySection.locator('.image-grid__remaining')).toHaveText('+3');
    await openImage(page, 'many', 8);
    await expect(counter(page)).toHaveText('9 / 12');
    for (const expected of ['10 / 12', '11 / 12', '12 / 12']) {
      await nextImage(page);
      await expect(counter(page)).toHaveText(expected);
    }
    await expect(viewerImage(page)).toHaveAttribute('src', '/images/full/many-12.svg');
  });
});

test.describe('长图阅读', () => {
  test('长图可放大与原图模式查看，并可拖动', async ({ page }) => {
    await page.goto('/__preview-fixtures');
    await openImage(page, 'long', 0);
    const image = viewerImage(page);
    await expect.poll(async () => image.evaluate(node => {
      const element = node as HTMLImageElement;
      return `${element.naturalWidth}x${element.naturalHeight}`;
    })).toBe('1200x6000');

    const viewportHeight = page.viewportSize()?.height ?? 720;
    const renderedHeight = async (): Promise<number> => image.evaluate(node => Math.round(node.getBoundingClientRect().height));
    expect(await renderedHeight()).toBeLessThanOrEqual(viewportHeight);

    for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowUp');
    await expect.poll(renderedHeight).toBeGreaterThan(viewportHeight * 1.5);

    const transformBefore = await image.evaluate(node => node.style.transform);
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const centerX = Math.round(viewport.width / 2);
    const centerY = Math.round(viewport.height / 2);
    // 从图片中心拖动：点击遮罩会关闭预览，所以必须确认起点在图上。
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y) instanceof HTMLImageElement, { x: centerX, y: centerY })).toBe(true);
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX, centerY - 150, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => image.evaluate(node => node.style.transform)).not.toBe(transformBefore);

    // 空格切换 contain / 原图（库原生键盘操作），原图模式下 1:1 渲染。
    await page.keyboard.press('Space');
    await expect.poll(renderedHeight).toBeGreaterThan(viewportHeight * 2);
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
  });
});
