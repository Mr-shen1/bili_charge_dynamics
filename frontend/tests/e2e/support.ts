import { expect, type Locator, type Page } from '@playwright/test';
import { previewStateKey } from '../../src/app/historyState';

export { previewStateKey };

export interface ImageRequest {
  path: string;
  status: number;
}

// mock 装配的自检第二页 → 自检图片页，用于验证“后退不多退一级 / 前进恢复”。
export async function startFromOtherPage(page: Page): Promise<void> {
  await page.goto('/__preview-other');
  await page.getByRole('link', { name: '进入图片验证页' }).click();
  await expect(page).toHaveURL(/__preview-fixtures$/);
}

/**
 * 评论排序按可见分段标签点击：Element Plus 隐藏原生 radio，用户点到的是 label 文本。
 * 用 radiogroup 的可访问名称与文字定位，不依赖库内部 class。
 */
export function sortOption(region: Locator, name: '最热' | '最新'): Locator {
  return region.getByRole('radiogroup', { name: '评论排序' }).getByText(name, { exact: true });
}

// Element Plus 没给预览根节点与预览图公开 role/可访问名，
// 因此把“库根 class”锚点收敛到这两个 helper；其余断言只用应用自有的
// 可访问名称、公开图片地址与可见文本，避免把库内部结构当契约。
export function viewer(page: Page) {
  return page.locator('.el-image-viewer__wrapper');
}

export function viewerImage(page: Page) {
  return viewer(page).locator('img');
}

export function counter(page: Page) {
  return page.locator('.preview-counter');
}

/** 库原生关闭按钮：与 viewer()/viewerToolbar() 同属已登记的库内部类例外。 */
export function viewerClose(page: Page) {
  return page.locator('.el-image-viewer__close');
}

/** 焦点是否留在预览层内：只看活跃元素是否被预览根节点包含。 */
export async function focusInsideViewer(page: Page): Promise<boolean> {
  return viewer(page).evaluate(node => node.contains(document.activeElement));
}

/** 库原生图标工具栏的可见性锚点；01 已把该内部类覆盖登记为唯一例外并由自动化守护。 */
export function viewerToolbar(page: Page) {
  return page.locator('.el-image-viewer__actions');
}

export async function openImage(page: Page, group: string, index: number): Promise<void> {
  await page.locator(`#preview-trigger-${group}-${index}`).click();
  await expect(viewer(page)).toBeVisible();
}

export async function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => history.length);
}

export async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY));
}

export async function previewState(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(key => {
    const state = history.state as Record<string, unknown> | null;
    return (state?.[key] as Record<string, unknown> | null | undefined) ?? null;
  }, previewStateKey);
}

export async function resetImageRequests(page: Page): Promise<void> {
  await page.request.get('/__reset');
}

export async function imageRequests(page: Page): Promise<ImageRequest[]> {
  const response = await page.request.get('/__requests');
  const payload = (await response.json()) as { requests: ImageRequest[] };
  return payload.requests;
}

export function pathsPrefixed(requests: ImageRequest[], prefix: string): string[] {
  return requests.filter(request => request.path.startsWith(prefix)).map(request => request.path);
}

export async function isCompact(page: Page): Promise<boolean> {
  return page.evaluate(() => matchMedia('(max-width: 640px)').matches);
}

export async function canTouch(page: Page): Promise<boolean> {
  return page.evaluate(() => navigator.maxTouchPoints > 0);
}

/** 模拟单指水平滑动（CDP 真实触摸序列）。 */
export async function swipe(page: Page, direction: 'next' | 'previous'): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 390, height: 720 };
  const y = Math.round(viewport.height / 2);
  const from = Math.round(viewport.width * (direction === 'next' ? 0.8 : 0.2));
  const to = Math.round(viewport.width * (direction === 'next' ? 0.2 : 0.8));
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
    for (let step = 1; step <= 6; step += 1) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x: Math.round(from + (to - from) * (step / 6)), y }],
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach();
  }
}

/**
 * 按当前断点走用户真实路径：宽屏用库原生箭头对应的键盘操作，窄屏用滑动。
 * 窄屏隐藏了库的切图箭头，键盘仍可用，所以无触摸环境回落到键盘。
 */
export async function nextImage(page: Page): Promise<void> {
  if ((await isCompact(page)) && (await canTouch(page))) {
    await swipe(page, 'next');
    return;
  }
  await page.keyboard.press('ArrowRight');
}

export async function previousImage(page: Page): Promise<void> {
  if ((await isCompact(page)) && (await canTouch(page))) {
    await swipe(page, 'previous');
    return;
  }
  await page.keyboard.press('ArrowLeft');
}

/** 双指张开/收拢：只缩放图片，不缩放页面。 */
export async function pinchImage(page: Page, factor: number): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 390, height: 720 };
  const centerX = Math.round(viewport.width / 2);
  const centerY = Math.round(viewport.height / 2);
  const start = 40;
  const end = Math.round(start * factor);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: centerX - start, y: centerY }, { x: centerX + start, y: centerY }],
    });
    for (let step = 1; step <= 6; step += 1) {
      const offset = Math.round(start + (end - start) * (step / 6));
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: centerX - offset, y: centerY }, { x: centerX + offset, y: centerY }],
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach();
  }
}

/** 单指拖动（放大后库的 pan 生效）。 */
export async function dragImage(page: Page, dx: number, dy: number): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 390, height: 720 };
  const startX = Math.round(viewport.width / 2);
  const startY = Math.round(viewport.height / 2);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y: startY }] });
    for (let step = 1; step <= 6; step += 1) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: startX + Math.round((dx * step) / 6), y: startY + Math.round((dy * step) / 6) }],
      });
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await client.detach();
  }
}

/** 双击图片中心（两次间隔小于应用的 300ms 判定）。 */
export async function doubleTapImage(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 390, height: 720 };
  const x = Math.round(viewport.width / 2);
  const y = Math.round(viewport.height / 2);
  const client = await page.context().newCDPSession(page);
  try {
    for (let index = 0; index < 2; index += 1) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(60);
    }
  } finally {
    await client.detach();
  }
}

export interface ImageBox {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export async function imageBox(page: Page): Promise<ImageBox> {
  return viewerImage(page).evaluate(node => {
    const box = node.getBoundingClientRect();
    return {
      width: Math.round(box.width),
      height: Math.round(box.height),
      centerX: Math.round(box.x + box.width / 2),
      centerY: Math.round(box.y + box.height / 2),
    };
  });
}

/** 等预览的进入动画稳定后再测量图片位置。 */
export async function waitForStableViewer(page: Page): Promise<void> {
  let previous = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = JSON.stringify(await imageBox(page));
    if (current === previous) return;
    previous = current;
    await page.waitForTimeout(100);
  }
  throw new Error('预览图片位置在超时内没有稳定');
}

export async function closeViewer(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
}

/** 库的切图箭头是否可见：窄屏应被隐藏，宽屏保留。 */
export async function navArrowVisibility(page: Page): Promise<{ prev: boolean; next: boolean }> {
  return page.evaluate(() => {
    const visible = (selector: string): boolean => {
      const node = document.querySelector(selector);
      if (!node) return false;
      const box = node.getBoundingClientRect();
      return getComputedStyle(node).display !== 'none' && box.width > 0 && box.height > 0;
    };
    return { prev: visible('.el-image-viewer__prev'), next: visible('.el-image-viewer__next') };
  });
}

export async function renderedImageBox(page: Page): Promise<{ width: number; height: number }> {
  return viewerImage(page).evaluate(node => {
    const box = node.getBoundingClientRect();
    return { width: Math.round(box.width), height: Math.round(box.height) };
  });
}

