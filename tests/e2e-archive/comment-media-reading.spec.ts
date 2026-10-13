import { expect, test, type Locator, type Page } from '@playwright/test';
import { commentImageUrl, installCommentMediaHttp, longNickname } from './fixtures/comment-media-http';
import { publicImageUrl } from './fixtures/media-http';
import { swipePreview } from '../e2e-support/touch';

const comment = (page: Page, id: string) => page.locator(`[data-reading-id="comment:${id}"]`);
const images = (page: Page, id: string) => comment(page, id).getByRole('group', { name: '评论图片', exact: true });
const trigger = (page: Page, id: string, position: number) => images(page, id).getByRole('button', { name: `预览图片 ${position}`, exact: true });

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error('Expected visible media bounds');
  return bounds;
}

async function settledFrame(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('生产评论单/四/其他/十二图四宽度网格、44px、长昵称与纯图/文字/空态', async ({ page }) => {
  await installCommentMediaHttp(page);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/dynamics/1004');
    await expect(comment(page, '2002').getByText(longNickname, { exact: true })).toBeVisible();
    for (const [id, count, columns] of [['1001', 1, 1], ['2002', 4, 2], ['2003', 3, 3], ['1004', 12, 3]] as const) {
      const group = images(page, id);
      await group.scrollIntoViewIfNeeded();
      const buttons = group.getByRole('button', { name: /^预览图片/ });
      await expect(buttons).toHaveCount(count);
      const bounds = await Promise.all((await buttons.all()).map(box));
      const first = bounds[0];
      if (!first) throw new Error('Expected nonempty comment image group');
      expect(bounds.filter(item => Math.abs(item.y - first.y) < 1)).toHaveLength(columns);
      for (const item of bounds) {
        expect(item.width).toBeGreaterThanOrEqual(44);
        expect(item.height).toBeGreaterThanOrEqual(44);
        expect(item.x).toBeGreaterThanOrEqual(0);
        expect(item.x + item.width).toBeLessThanOrEqual(width);
        if (count > 1) expect(item.width).toBeCloseTo(item.height, 0);
      }
      if (count === 1) {
        expect(first.height).toBeLessThanOrEqual(360);
        expect(first.width / first.height).toBeCloseTo(1 / 4, 2);
      }
      await expect(comment(page, id).getByText('暂无评论内容', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await expect(comment(page, '2004').getByText('纯文字评论', { exact: true })).toHaveCount(1);
    await expect(images(page, '2004')).toHaveCount(0);
    await expect(comment(page, '2004').getByText('暂无评论内容', { exact: true })).toHaveCount(0);
    await expect(comment(page, '2005').getByText('暂无评论内容', { exact: true })).toHaveCount(1);
    await expect(images(page, '2005')).toHaveCount(0);
    await expect(images(page, '1004').getByText('+3', { exact: true })).toHaveCount(0);
    await trigger(page, '1004', 12).click();
    const preview = page.getByRole('dialog', { name: '图片预览' });
    await expect(preview.getByText('12 / 12', { exact: true })).toBeVisible();
    await expect(preview.getByRole('img')).toHaveAttribute('src', commentImageUrl('1004', 11));
    await expect(preview.getByRole('img')).toHaveCSS('object-fit', 'contain');
    await page.keyboard.press('Escape');
    await expect(trigger(page, '1004', 12)).toBeFocused();
  }
});

test('两个评论组与同 ID 动态组隔离，反复切组、后退/前进恢复组内末图、焦点与滚动', async ({ page }) => {
  const service = await installCommentMediaHttp(page);
  await page.goto('/dynamics/1004?view=reader#local');
  await expect(comment(page, '1004')).toHaveCount(1);
  await settledFrame(page);
  const initialReads = service.commentReads.length;
  const preview = page.getByRole('dialog', { name: '图片预览' });
  const url = page.url();
  const length = await page.evaluate(() => history.length);
  for (const [owner, position, total] of [['1004', 9, 12], ['2002', 2, 4], ['dynamic', 9, 12], ['1004', 1, 12]] as const) {
    const button = owner === 'dynamic'
      ? page.getByRole('group', { name: '动态图片', exact: true }).getByRole('button', { name: `预览图片 ${position}`, exact: true })
      : trigger(page, owner, position);
    await button.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    const mainTop = (await box(page.locator('main'))).y;
    await button.click();
    await expect(preview.getByText(`${position} / ${total}`, { exact: true })).toBeVisible();
    const imageUrl = owner === 'dynamic' ? publicImageUrl('1004', position - 1) : commentImageUrl(owner, position - 1);
    await expect(preview.getByRole('img')).toHaveAttribute('src', imageUrl);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      expect(await preview.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('ArrowRight');
    await expect(preview.getByText(`${position + 1} / ${total}`, { exact: true })).toBeVisible();
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    await page.mouse.wheel(0, 400);
    expect((await box(page.locator('main'))).y).toBeCloseTo(mainTop, 0);
    await page.goBack();
    await expect(preview).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
    await page.goForward();
    await expect(preview.getByText(`${position + 1} / ${total}`, { exact: true })).toBeVisible();
    await expect(preview.getByRole('img')).toHaveAttribute('src', owner === 'dynamic'
      ? publicImageUrl('1004', position) : commentImageUrl(owner, position));
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(button).toBeFocused();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
    expect(await page.evaluate(() => document.body.style.position)).not.toBe('fixed');
    expect(page.url()).toBe(url);
  }
  expect(service.commentReads).toHaveLength(initialReads);
});

test('排序卸载触发处后前进仍恢复原评论图，关闭聚焦 main；刷新清理遗留预览且不多退', async ({ page }) => {
  const service = await installCommentMediaHttp(page);
  await page.goto('/dynamics/1004');
  await trigger(page, '1004', 9).click();
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await expect(preview.getByText('9 / 12', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '下一张', exact: true }).click();
  await expect(preview.getByText('10 / 12', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(trigger(page, '1004', 9)).toBeFocused();
  await page.getByRole('button', { name: '最新', exact: true }).click();
  await expect(comment(page, '4000').getByText('排序后的评论', { exact: true })).toBeVisible();
  await expect(comment(page, '1004')).toHaveCount(0);
  expect(service.commentReads.some(query => query.includes('sort=latest'))).toBe(true);
  const length = await page.evaluate(() => history.length);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goForward();
    await expect(preview.getByText('10 / 12', { exact: true })).toBeVisible();
    await expect(preview.getByRole('img')).toHaveAttribute('src', commentImageUrl('1004', 9));
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(page.locator('main')).toBeFocused();
    await expect(comment(page, '4000')).toBeVisible();
    expect(page.url()).toMatch(/\/dynamics\/1004$/);
    expect(await page.evaluate(() => history.length)).toBe(length);
  }
  await page.goForward();
  await expect(preview).toBeVisible();
  await page.reload();
  await expect(comment(page, '1004')).toHaveCount(1);
  await expect(preview).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state.usr?.previewId)).toBeUndefined();
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack();
  await page.goForward();
  await expect(preview).toHaveCount(0);
  expect(page.url()).toMatch(/\/dynamics\/1004$/);
  expect(await page.evaluate(() => document.body.style.position)).not.toBe('fixed');
});

test('归档 pending/failed 与浏览器坏图区分，原 URL 局部重试、切走/关闭、不回退来源', async ({ page }) => {
  const service = await installCommentMediaHttp(page);
  const url = commentImageUrl('2002', 0);
  service.broken.add(url);
  await page.goto('/dynamics/1004');
  const statusGroup = images(page, '2003');
  await statusGroup.scrollIntoViewIfNeeded();
  await expect(statusGroup.getByText('图片待归档', { exact: true })).toBeVisible();
  await expect(statusGroup.getByText('图片归档失败', { exact: true })).toBeVisible();
  await expect(statusGroup.getByRole('button', { name: /^重试图片/ })).toHaveCount(0);
  const preview = page.getByRole('dialog', { name: '图片预览' });
  for (const [position, message] of [[1, '图片待归档'], [2, '图片归档失败']] as const) {
    await trigger(page, '2003', position).click();
    await expect(preview.getByText(`${position} / 3`, { exact: true })).toBeVisible();
    await expect(preview.getByText(message, { exact: true })).toBeVisible();
    await expect(preview.getByRole('button', { name: /^重试/ })).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(preview.getByText(`${position + 1} / 3`, { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger(page, '2003', position)).toBeFocused();
  }
  const group = images(page, '2002');
  await group.scrollIntoViewIfNeeded();
  await expect(group.getByText('图片加载失败', { exact: true })).toBeVisible();
  await expect(comment(page, '2002').getByText('四图评论正文', { exact: true })).toBeVisible();
  const beforeThumbnailRetry = service.attempts.get(url) ?? 0;
  service.broken.delete(url);
  await group.getByRole('button', { name: '重试图片 1', exact: true }).click();
  await expect.poll(() => group.getByRole('img', { name: '图片 1', exact: true }).evaluate(element =>
    element instanceof HTMLImageElement && element.naturalWidth)).toBe(600);
  await expect.poll(() => service.attempts.get(url)).toBe(beforeThumbnailRetry + 1);
  service.broken.add(url);
  await trigger(page, '2002', 1).click();
  await expect(preview.getByText('图片加载失败', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '下一张', exact: true }).click();
  await expect(preview.getByRole('img')).toHaveAttribute('src', commentImageUrl('2002', 1));
  await preview.getByRole('button', { name: '上一张', exact: true }).click();
  await expect(preview.getByText('图片加载失败', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(trigger(page, '2002', 1)).toBeFocused();
  await trigger(page, '2002', 1).click();
  await expect(preview.getByText('图片加载失败', { exact: true })).toBeVisible();
  const beforePreviewRetry = service.attempts.get(url) ?? 0;
  service.broken.delete(url);
  await preview.getByRole('button', { name: '重试预览图片 1', exact: true }).click();
  await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(600);
  await expect.poll(() => service.attempts.get(url)).toBe(beforePreviewRetry + 1);
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByRole('img')).toHaveAttribute('src', commentImageUrl('2002', 1));
  await page.keyboard.press('Escape');
  await expect(trigger(page, '2002', 1)).toBeFocused();
  expect(page.url()).toMatch(/\/dynamics\/1004$/);
  expect(service.requests.filter(request => request.includes('source.example.test'))).toEqual([]);
  expect(service.requests.filter(request => request === commentImageUrl('2003', 0) || request === commentImageUrl('2003', 1))).toEqual([]);
  expect(service.requests.filter(request => request.includes('/comments/')).every(request =>
    /^https:\/\/oss\.example\.test\/archive\/comments\/\d+\/\d+\.svg\?literal=a%2Fb&v=1$/.test(request))).toBe(true);
});

test('缩略 lazy、预览 eager，未看评论组无请求，打开一图不预取全组', async ({ page }) => {
  const service = await installCommentMediaHttp(page);
  await page.goto('/dynamics/1004');
  await expect(images(page, '1004').getByRole('img')).toHaveCount(12);
  for (const image of await page.getByRole('group', { name: '评论图片', exact: true }).getByRole('img').all()) {
    await expect(image).toHaveAttribute('loading', 'lazy');
  }
  expect(service.requests.some(url => url.includes('/comments/1004/'))).toBe(false);
  await images(page, '2002').scrollIntoViewIfNeeded();
  for (const image of await images(page, '2002').getByRole('img').all()) {
    await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(600);
  }
  const before = service.requests.length;
  await trigger(page, '2002', 1).click();
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await expect(preview.getByRole('img')).toHaveAttribute('src', commentImageUrl('2002', 0));
  await expect(preview.getByRole('img')).toHaveAttribute('loading', 'eager');
  await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(600);
  await settledFrame(page);
  expect(service.requests.slice(before).filter(url => url.includes('/comments/'))).toEqual([commentImageUrl('2002', 0)]);
  expect(service.requests.some(url => url.includes('/comments/1004/'))).toBe(false);
  const afterFirst = service.requests.length;
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByRole('img')).toHaveAttribute('src', commentImageUrl('2002', 1));
  await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(600);
  await settledFrame(page);
  expect(service.requests.slice(afterFirst).filter(url => url.includes('/comments/'))).toEqual([commentImageUrl('2002', 1)]);
  await page.keyboard.press('Escape');
});

test('慢长图占位稳定；四宽度完整/适宽，原生触控纵读不误切不滚底层、切图归零与首尾单图边界', async ({ page }) => {
  const service = await installCommentMediaHttp(page);
  const release = service.pause(commentImageUrl('1007', 0));
  await page.goto('/dynamics/1004', { waitUntil: 'domcontentloaded' });
  await trigger(page, '1007', 1).scrollIntoViewIfNeeded();
  await expect(comment(page, '1007').getByText('图片加载中', { exact: true })).toBeVisible();
  const reserved = await box(trigger(page, '1007', 1));
  await trigger(page, '1007', 1).click();
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await expect(preview.getByText('图片加载中', { exact: true })).toBeVisible();
  release();
  await expect(preview.getByRole('button', { name: '适应宽度', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await box(trigger(page, '1007', 1))).height).toBeCloseTo(reserved.height, 1);
  const stage = preview.getByRole('region', { name: '预览图片阅读区域' });
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await trigger(page, '1001', 1).click();
    await expect(preview.getByText('1 / 1', { exact: true })).toBeVisible();
    await expect(preview.getByRole('button', { name: /上一张|下一张/ })).toHaveCount(0);
    await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalHeight)).toBe(2400);
    const whole = await box(preview.getByRole('img'));
    const bounds = await box(stage);
    expect(whole.width / whole.height).toBeCloseTo(1 / 4, 2);
    expect(whole.height).toBeLessThanOrEqual(bounds.height);
    await preview.getByRole('button', { name: '适应宽度', exact: true }).click();
    expect((await box(preview.getByRole('img'))).width).toBeCloseTo(bounds.width, 0);
    const mainTop = (await box(page.locator('main'))).y;
    await stage.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    expect((await box(page.locator('main'))).y).toBeCloseTo(mainTop, 0);
    if (width === 390) {
      await swipePreview(page, -25, -200);
      await swipePreview(page, -110, 5);
      await page.keyboard.press('ArrowRight');
      await expect(preview.getByText('1 / 1', { exact: true })).toBeVisible();
    }
    await preview.getByRole('button', { name: '完整显示', exact: true }).click();
    expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(trigger(page, '1001', 1)).toBeFocused();
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await trigger(page, '2002', 1).click();
  await expect(preview.getByRole('button', { name: '上一张', exact: true })).toBeDisabled();
  await swipePreview(page, 110, 5);
  await page.keyboard.press('ArrowLeft');
  await expect(preview.getByText('1 / 4', { exact: true })).toBeVisible();
  await swipePreview(page, -110, 5);
  await expect(preview.getByText('2 / 4', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await trigger(page, '1004', 12).click();
  await expect(preview.getByRole('button', { name: '下一张', exact: true })).toBeDisabled();
  await swipePreview(page, -110, 5);
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByText('12 / 12', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '适应宽度', exact: true }).click();
  const mainTop = (await box(page.locator('main'))).y;
  await swipePreview(page, -30, -220);
  await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await expect(preview.getByText('12 / 12', { exact: true })).toBeVisible();
  expect((await box(page.locator('main'))).y).toBeCloseTo(mainTop, 0);
  await swipePreview(page, 110, 5);
  await expect(preview.getByText('11 / 12', { exact: true })).toBeVisible();
  expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(trigger(page, '1004', 12)).toBeFocused();
});
