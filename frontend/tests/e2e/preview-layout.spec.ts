import { expect, test } from '@playwright/test';
import { closeViewer, counter, navArrowVisibility, openImage, scrollY, viewer } from './support';

const widths = [360, 390, 768, 1280] as const;

test.describe('四宽度布局与触控', () => {
  for (const width of widths) {
    test(`${width}px 无页面横溢，工具栏可达且触控区域不小于 44px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.goto('/__preview-fixtures');

      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);

      const tiles = await page.locator('.image-grid__trigger').evaluateAll(nodes => nodes.slice(0, 6).map(node => {
        const box = node.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height) };
      }));
      expect(tiles.length).toBeGreaterThan(0);
      for (const tile of tiles) expect(tile.height).toBeGreaterThanOrEqual(44);

      // 滚动后打开：预览期间位置不变，关闭后也不跳位。
      const tile = page.locator('#preview-trigger-many-3');
      await tile.scrollIntoViewIfNeeded();
      const before = await scrollY(page);

      await openImage(page, 'many', 3);
      await expect(counter(page)).toBeVisible();
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(200);
      expect(await scrollY(page)).toBe(before);
      // 不再有文字版“关闭预览”按钮：宽屏用库右上角关闭，窄屏下滑动/双指 + 右上角关闭。
      await expect(page.getByRole('button', { name: '关闭预览' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '下一张' })).toHaveCount(0);

      // 宽屏保留库原生切图箭头；窄屏已被隐藏，改用滑动。
      const arrows = await navArrowVisibility(page);
      if (width <= 640) {
        expect(arrows).toEqual({ prev: false, next: false });
      } else {
        expect(arrows).toEqual({ prev: true, next: true });
      }

      // 库自带的右上角关闭按钮保持 44px 触控区（宽窄屏一致）。
      const closeBox = await page.locator('.el-image-viewer__close').evaluate(node => {
        const box = node.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height) };
      });
      expect(closeBox.width).toBeGreaterThanOrEqual(44);
      expect(closeBox.height).toBeGreaterThanOrEqual(44);


      await closeViewer(page);
      await expect(viewer(page)).toHaveCount(0);
      expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(1);
    });
  }
});
