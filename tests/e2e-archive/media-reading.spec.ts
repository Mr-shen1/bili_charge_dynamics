import { expect, test } from '@playwright/test';
import { installMediaHttp, publicImageUrl } from './fixtures/media-http';
import { swipePreview } from '../e2e-support/touch';

test('生产图片逐图归档状态与浏览器坏图不同，不请求来源图，纯图无空正文提示', async ({ page }) => {
  const service = await installMediaHttp(page);
  await page.goto('/dynamics/1002');
  const card = page.getByRole('article');
  await expect(card.getByRole('group', { name: '动态图片' })).toBeVisible();
  await expect(card.getByText(/图片待归档/)).toHaveCount(0);
  await expect(card.getByText('暂无内容', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('img', { name: '归档作者的头像', exact: true })).toHaveAttribute('src', 'https://avatar.example.test/reader.svg');
  await page.goto('/dynamics/1005');
  await expect(card.getByText('图片待归档', { exact: true })).toBeVisible();
  await expect(card.getByText('图片归档失败', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: /^重试图片/ })).toHaveCount(0);
  await card.getByRole('button', { name: '预览图片 2', exact: true }).click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('2 / 3')).toBeVisible();
  await expect(preview.getByText('图片归档失败', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByRole('img')).toHaveAttribute('src', publicImageUrl('1005', 2));
  await page.keyboard.press('Escape');
  await expect(card.getByRole('button', { name: '预览图片 2', exact: true })).toBeFocused();
  expect(service.requests.filter(url => url.includes('source.example.test'))).toEqual([]);
  expect(service.requests.filter(url => url.includes('/1005/0') || url.includes('/1005/1'))).toEqual([]);
});

test('生产单/四/九/十二图四宽度网格；列表九格是展示上限，纯文字无空图区', async ({ page }) => {
  await installMediaHttp(page);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [id, count, columns] of [['1001', 1, 1], ['1002', 4, 2], ['1003', 9, 3], ['1004', 12, 3]] as const) {
      await page.goto(`/dynamics/${id}`);
      const group = page.getByRole('group', { name: '动态图片' });
      const buttons = group.getByRole('button', { name: /^预览图片/ });
      await expect(buttons).toHaveCount(count);
      const boxes = await Promise.all((await buttons.all()).map(button => button.boundingBox()));
      expect(boxes.filter(box => box && Math.abs(box.y - boxes[0]!.y) < 1)).toHaveLength(columns);
      for (const box of boxes) {
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.goto('/');
    const many = page.getByRole('article').filter({ has: page.getByRole('link', { name: '阅读全文 1004', exact: true }) });
    await expect(many.getByRole('button', { name: /^预览图片/ })).toHaveCount(9);
    await expect(many.getByText('+3', { exact: true })).toBeVisible();
    const single = page.getByRole('article').first().getByRole('button', { name: '预览图片 1', exact: true });
    expect((await single.boundingBox())!.height).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const text = page.getByRole('article').filter({ has: page.getByText('纯文字 1006', { exact: true }) });
    await expect(text.getByRole('group', { name: '动态图片' })).toHaveCount(0);
  }
});

test('公开 URL 原样直连、缩略懒加载；打开九格末图不预取整组，详情可访问十二张', async ({ page }) => {
  // 移除归档信息后卡片更短；固定较矮视口，保证末图仍在浏览器 lazy 阈值之外。
  await page.setViewportSize({ width: 1280, height: 200 });
  const service = await installMediaHttp(page);
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(10);
  expect(service.requests.some(url => url.includes('/1008/'))).toBe(false);
  const many = page.getByRole('article').filter({ has: page.getByRole('link', { name: '阅读全文 1004', exact: true }) });
  const trigger = many.getByRole('button', { name: '预览图片 9', exact: true });
  await trigger.click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('9 / 12')).toBeVisible();
  await expect(preview.getByRole('img')).toHaveAttribute('src', publicImageUrl('1004', 8));
  expect(service.requests.filter(url => /\/1004\/(9|10|11)\.svg/.test(url))).toEqual([]);
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByRole('img')).toHaveAttribute('src', publicImageUrl('1004', 9));
  await expect.poll(() => service.requests.includes(publicImageUrl('1004', 9))).toBe(true);
  expect(service.requests.filter(url => /\/1004\/(10|11)\.svg/.test(url))).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await many.getByRole('link', { name: '阅读全文 1004', exact: true }).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(/\/dynamics\/1004$/);
  await page.getByRole('button', { name: '预览图片 12', exact: true }).click();
  await expect(preview.getByText('12 / 12')).toBeVisible();
  await expect(preview.getByRole('img')).toHaveAttribute('src', publicImageUrl('1004', 11));
  await expect(preview.getByRole('button', { name: '下一张', exact: true })).toBeDisabled();
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByText('12 / 12')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(service.requests.filter(url => url.includes('source.example.test'))).toEqual([]);
  expect(service.requests.filter(url => url.includes('oss.example.test')).every(url =>
    /^https:\/\/oss\.example\.test\/archive\/\d+\/\d+\.svg\?literal=a%2Fb&v=1$/.test(url))).toBe(true);
});

test('坏图原 URL 局部重试，切图与关闭可用，不触发卡片导航或丢正文', async ({ page }) => {
  const service = await installMediaHttp(page);
  const url = publicImageUrl('1004', 0);
  service.broken.add(url);
  await page.goto('/');
  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: '阅读全文 1004', exact: true }) });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText('图片加载失败', { exact: true })).toBeVisible();
  await expect(card.getByText(/动态图正文 1/)).toBeVisible();
  service.broken.delete(url);
  await card.getByRole('button', { name: '重试图片 1', exact: true }).click();
  await expect(card.getByText('图片加载失败', { exact: true })).toHaveCount(0);
  await expect.poll(() => service.attempts.get(url)).toBe(2);
  expect(page.url()).toMatch(/\/$/);
  service.broken.add(url);
  const trigger = card.getByRole('button', { name: '预览图片 1', exact: true });
  await trigger.click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('图片加载失败', { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: '上一张', exact: true })).toBeDisabled();
  service.broken.delete(url);
  await preview.getByRole('button', { name: '重试预览图片 1', exact: true }).click();
  await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(600);
  await expect.poll(() => service.attempts.get(url)).toBe(4);
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByText('2 / 12')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  expect(page.url()).toMatch(/\/$/);
});

test('生产预览历史只一条、前进恢复最后图片，关闭恢复多批/展开/焦点与阅读位置；刷新有界清理', async ({ page }) => {
  await installMediaHttp(page);
  await page.goto('/?view=reader#local');
  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: '阅读全文 1004', exact: true }) });
  await card.getByRole('button', { name: '展开正文', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  const trigger = card.getByRole('button', { name: '预览图片 9', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  const mainTop = (await page.locator('main').boundingBox())!.y;
  const length = await page.evaluate(() => history.length);
  const url = page.url();
  await trigger.click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('9 / 12')).toBeVisible();
  expect(page.url()).toBe(url);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await preview.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('ArrowRight');
  await preview.getByRole('button', { name: '下一张', exact: true }).click();
  await expect(preview.getByText('11 / 12')).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.mouse.wheel(0, 400);
  expect((await page.locator('main').boundingBox())!.y).toBeCloseTo(mainTop, 0);
  await page.goBack();
  await expect(preview).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect(card.getByRole('button', { name: '收起正文', exact: true })).toHaveCount(1);
  await page.goForward();
  await expect(preview.getByText('11 / 12')).toBeVisible();
  await expect(preview.getByRole('img')).toHaveAttribute('src', publicImageUrl('1004', 10));
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y);
  await trigger.click();
  await expect(preview).toBeVisible();
  const beforeReload = await page.evaluate(() => history.length);
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(10);
  await expect(preview).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => history.state.usr?.previewId)).toBeUndefined();
  expect(await page.evaluate(() => history.length)).toBe(beforeReload);
  await page.goBack();
  await page.goForward();
  await expect(preview).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.position)).not.toBe('fixed');
});

test('生产缺尺寸慢长图保持占位；四宽度完整/适宽和触控纵读不误切、不动底层，单图不切换', async ({ page }) => {
  const service = await installMediaHttp(page);
  const release = service.pause(publicImageUrl('1007', 0));
  await page.goto('/dynamics/1007', { waitUntil: 'domcontentloaded' });
  const trigger = page.getByRole('button', { name: '预览图片 1', exact: true });
  await expect(trigger).toBeVisible();
  const reserved = (await trigger.boundingBox())!;
  await trigger.click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('图片加载中')).toBeVisible();
  release();
  await expect(preview.getByRole('button', { name: '适应宽度', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await trigger.boundingBox())!.height).toBeCloseTo(reserved.height, 1);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await trigger.click();
    await expect(preview.getByText('1 / 1')).toBeVisible();
    await expect(preview.getByRole('button', { name: /上一张|下一张/ })).toHaveCount(0);
    await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalHeight)).toBe(2400);
    const image = preview.getByRole('img');
    const stage = preview.getByRole('region', { name: '预览图片阅读区域' });
    const bounds = (await stage.boundingBox())!;
    const whole = (await image.boundingBox())!;
    expect(whole.width / whole.height).toBeCloseTo(1 / 4, 2);
    expect(whole.height).toBeLessThanOrEqual(bounds.height);
    await preview.getByRole('button', { name: '适应宽度', exact: true }).click();
    expect((await image.boundingBox())!.width).toBeCloseTo(bounds.width, 0);
    const mainTop = (await page.locator('main').boundingBox())!.y;
    await stage.hover();
    await page.mouse.wheel(0, 400);
    await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
    expect((await page.locator('main').boundingBox())!.y).toBeCloseTo(mainTop, 0);
    if (width === 390) {
      await swipePreview(page, -25, -200);
      await expect(preview.getByText('1 / 1')).toBeVisible();
      await swipePreview(page, -110, 5);
      await expect(preview.getByText('1 / 1')).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/dynamics/1002');
  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  await swipePreview(page, 110, 5);
  await expect(preview.getByText('1 / 4')).toBeVisible();
  await swipePreview(page, -110, 5);
  await expect(preview.getByText('2 / 4')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await swipePreview(page, -110, 5);
  await expect(preview.getByText('4 / 4')).toBeVisible();
  const stage = preview.getByRole('region', { name: '预览图片阅读区域' });
  expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');
  await page.goto('/dynamics/1004');
  await page.getByRole('button', { name: '预览图片 12', exact: true }).click();
  await preview.getByRole('button', { name: '适应宽度', exact: true }).click();
  const mainTop = (await page.locator('main').boundingBox())!.y;
  await swipePreview(page, -30, -220);
  await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await expect(preview.getByText('12 / 12')).toBeVisible();
  expect((await page.locator('main').boundingBox())!.y).toBeCloseTo(mainTop, 0);
  await swipePreview(page, 110, 5);
  await expect(preview.getByText('11 / 12')).toBeVisible();
  expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
  await page.keyboard.press('Escape');
});

test('生产多批历史遇慢图片、缺尺寸与跨宽度恢复后，迟到图片不会覆盖用户滚动', async ({ page }) => {
  const service = await installMediaHttp(page);
  const release = service.pause(publicImageUrl('1008', 0));
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: '阅读全文 1008', exact: true }) });
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByText('图片加载中', { exact: true })).toBeVisible();
  const frame = (await card.getByRole('button', { name: '预览图片 1', exact: true }).boundingBox())!;
  await card.getByRole('link', { name: '阅读全文 1008', exact: true }).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(/\/dynamics\/1008$/);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect(card).toBeInViewport();
  const restored = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 350);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(restored + 100);
  const chosen = await page.evaluate(() => scrollY);
  release();
  await expect.poll(() => card.getByRole('img', { name: '图片 1', exact: true }).evaluate(element =>
    element instanceof HTMLImageElement && element.naturalWidth)).toBe(600);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => scrollY)).toBeCloseTo(chosen, 0);
  // 宽度重排允许改变框高；迟到解码不得在当前宽度再重排外框。
  expect((await card.getByRole('button', { name: '预览图片 1', exact: true }).boundingBox())!.height).toBeLessThanOrEqual(frame.height);
});
