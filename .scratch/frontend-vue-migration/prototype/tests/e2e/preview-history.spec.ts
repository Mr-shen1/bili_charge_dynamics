import { expect, test } from '@playwright/test';
import {
  closeViewer, counter, historyLength, nextImage, openImage, previewState, previewStateKey, scrollY,
  startFromOtherPage, viewer, viewerImage,
} from './support';

test.describe('预览历史与关闭来源', () => {
  test('打开只新增一条同 URL 记录，切图不新增记录', async ({ page }) => {
    await startFromOtherPage(page);
    const before = await historyLength(page);
    const url = page.url();

    await openImage(page, 'many', 2);
    await expect(counter(page)).toHaveText('3 / 12');
    expect(page.url()).toBe(url);
    expect(await historyLength(page)).toBe(before + 1);

    await nextImage(page);
    await expect(counter(page)).toHaveText('4 / 12');
    await nextImage(page);
    await expect(counter(page)).toHaveText('5 / 12');

    expect(page.url()).toBe(url);
    expect(await historyLength(page)).toBe(before + 1);
    const state = await previewState(page);
    expect(state).not.toBeNull();
    expect(state?.index).toBe(4);
    expect(Object.keys(state ?? {}).sort()).toEqual(['groupId', 'index', 'previewId', 'sessionId']);
    // 历史元数据只有标识与索引，不含图片内容或阅读快照。
    expect(JSON.stringify(state).length).toBeLessThan(300);
  });

  test('按钮关闭只退回预览记录，不二次后退', async ({ page }) => {
    await startFromOtherPage(page);
    const before = await historyLength(page);

    await openImage(page, 'quad', 1);
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    expect(await historyLength(page)).toBe(before + 1);

    await page.goBack();
    await expect(page).toHaveURL(/\/other$/);
  });

  test('浏览器后退关闭预览、前进恢复对应图片', async ({ page }) => {
    await startFromOtherPage(page);
    await openImage(page, 'many', 2);
    await nextImage(page);
    await nextImage(page);
    await expect(counter(page)).toHaveText('5 / 12');

    await page.goBack();
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    expect(await previewState(page)).toBeNull();

    await page.goForward();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('5 / 12');

    // 前进恢复的预览同样可以正常关闭，并且只退一步到起点页。
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/other$/);
  });

  test('Escape 关闭与按钮关闭同样只退一步', async ({ page }) => {
    await startFromOtherPage(page);
    await openImage(page, 'single', 0);

    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/other$/);
  });

  test('遮罩不触发关闭：避免双击缩略图或拖动长图时误关', async ({ page }) => {
    await startFromOtherPage(page);
    const before = await historyLength(page);
    await openImage(page, 'quad', 0);

    await page.mouse.click(8, 8);
    await expect(viewer(page)).toBeVisible();
    expect(await historyLength(page)).toBe(before + 1);
    expect(await previewState(page)).not.toBeNull();

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/other$/);
  });

  test('重复关闭与重复开关不会多退一级或出现双预览', async ({ page }) => {
    await startFromOtherPage(page);
    const before = await historyLength(page);

    await openImage(page, 'quad', 0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);

    await openImage(page, 'quad', 2);
    await expect(counter(page)).toHaveText('3 / 4');
    expect(await page.locator('.el-image-viewer__wrapper').count()).toBe(1);
    expect(await viewerImage(page).count()).toBe(1);
    expect(await historyLength(page)).toBe(before + 1);

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/other$/);
  });

  test('快速重复点击只新增一条预览记录', async ({ page }) => {
    await startFromOtherPage(page);
    const before = await historyLength(page);

    await page.locator('#preview-trigger-quad-0').dblclick();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('1 / 4');
    expect(await historyLength(page)).toBe(before + 1);
    expect(await viewer(page).count()).toBe(1);

    // 只关闭一次就能完全退出，说明没有残留的第二条预览记录。
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/other$/);
  });

  test('打开、切图与关闭都不重挂载底层页面', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => document.querySelector('[data-group="many"]')?.setAttribute('data-mount-probe', 'kept'));

    await openImage(page, 'many', 1);
    await nextImage(page);
    await expect(counter(page)).toHaveText('3 / 12');
    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);

    // 同 URL 预览只改历史记录，底层页面节点与阅读状态不被重建。
    await expect(page.locator('[data-group="many"][data-mount-probe="kept"]')).toHaveCount(1);
  });

  test('刷新后失效标记被清理，不重开预览也不落空弹层', async ({ page }) => {
    await startFromOtherPage(page);
    await openImage(page, 'quad', 3);
    await page.reload();

    await expect(viewer(page)).toHaveCount(0);
    expect(await previewState(page)).toBeNull();
    const state = await page.evaluate(() => history.state as Record<string, unknown>);
    expect(previewStateKey in state).toBe(true);

    // 刷新保留着已经消费过的同 URL 记录，但标记已清理：后退先回到同一地址且不出现空弹层，再退到起点页。
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(viewer(page)).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/other$/);
  });

  test('损坏的遗留标记在加载时被替换清理', async ({ page }) => {
    await startFromOtherPage(page);
    await page.evaluate(key => {
      history.replaceState({ ...history.state, [key]: { sessionId: 'other' } }, '');
    }, previewStateKey);
    await page.reload();

    await expect(viewer(page)).toHaveCount(0);
    expect(await previewState(page)).toBeNull();
  });
});

test.describe('焦点、滚动与恢复', () => {
  test('预览期间焦点留在预览内、底层不滚动，关闭恢复触发焦点与位置', async ({ page }) => {
    await page.goto('/');
    const tile = page.locator('#preview-trigger-quad-0');
    await tile.scrollIntoViewIfNeeded();
    const before = await scrollY(page);
    expect(before).toBeGreaterThan(100);

    await tile.focus();
    await page.keyboard.press('Enter');
    await expect(viewer(page)).toBeVisible();

    const insideViewer = async (): Promise<boolean> =>
      page.evaluate(() => !!document.activeElement?.closest('.el-image-viewer__wrapper'));
    expect(await insideViewer()).toBe(true);

    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(200);
    expect(await scrollY(page)).toBe(before);

    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.press('Tab');
      expect(await insideViewer()).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('preview-trigger-quad-0');
    expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(1);

    // 滚动锁只由库加一次，关闭后必须完全释放，否则会出现双重锁定残留。
    await expect.poll(async () => {
      await page.mouse.wheel(0, 300);
      return scrollY(page);
    }, { timeout: 5000 }).toBeGreaterThan(before);
  });

  test('触发器消失时关闭退到页面后备焦点位置', async ({ page }) => {
    await page.goto('/');
    const tile = page.locator('#preview-trigger-quad-1');
    await tile.scrollIntoViewIfNeeded();
    const before = await scrollY(page);
    await openImage(page, 'quad', 1);

    await page.evaluate(() => document.getElementById('preview-trigger-quad-1')?.remove());
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);

    expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-preview-fallback-focus') ?? false)).toBe(true);
    expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(1);
  });
});
