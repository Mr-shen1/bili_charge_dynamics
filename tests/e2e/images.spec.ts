import { expect, test } from '@playwright/test';

const singleId = '90071992547409932';
const fourId = '90071992547409934';
const nineId = '90071992547409935';
const manyId = '90071992547409936';
const unknownSizeId = '90071992547409937';

test('列表与详情基础预览只新增同 URL 一条历史，切图不堆栈，关闭恢复位置与焦点', async ({ page }) => {
  await page.goto('/?view=reader#local');
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  const card = page.getByRole('article').filter({ has: page.getByText('图文日记 6', { exact: false }) });
  const trigger = card.getByRole('button', { name: '预览图片 9', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const originalY = await page.evaluate(() => window.scrollY);
  const originalMainTop = (await page.locator('main').boundingBox())!.y;
  const url = page.url();
  const length = await page.evaluate(() => history.length);
  await trigger.click();
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await expect(preview.getByText('9 / 12')).toBeVisible();
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.mouse.wheel(0, 500);
  await expect.poll(async () => (await page.locator('main').boundingBox())!.y).toBeCloseTo(originalMainTop, 0);
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await preview.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('ArrowRight');
  await preview.getByRole('button', { name: '下一张' }).click();
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByText('12 / 12')).toBeVisible();
  await expect(preview.getByRole('button', { name: '下一张' })).toBeDisabled();
  const portrait = preview.getByRole('img');
  await expect.poll(() => portrait.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(600);
  const portraitBox = await portrait.boundingBox();
  expect(portraitBox!.width / portraitBox!.height).toBeCloseTo(600 / 1600, 2);
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(portraitBox!.x).toBeGreaterThanOrEqual(0);
  expect(portraitBox!.y).toBeGreaterThanOrEqual(0);
  expect(portraitBox!.x + portraitBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(portraitBox!.y + portraitBox!.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByText('12 / 12')).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  expect(page.url()).toBe(url);
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(originalY, 0);
  await expect(page.getByRole('article')).toHaveCount(20);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(originalY);

  await card.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(new RegExp(`/dynamics/${manyId}$`));
  const detailTrigger = page.getByRole('button', { name: '预览图片 12', exact: true });
  await detailTrigger.scrollIntoViewIfNeeded();
  const detailY = await page.evaluate(() => window.scrollY);
  await detailTrigger.click();
  await expect(preview.getByText('12 / 12')).toBeVisible();
  await preview.getByRole('button', { name: '上一张' }).click();
  await preview.getByRole('button', { name: '关闭预览' }).evaluate(button => { if (button instanceof HTMLButtonElement) { button.click(); button.click(); } });
  await expect(preview).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/dynamics/${manyId}$`));
  await expect(detailTrigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(detailY, 0);
  await detailTrigger.click();
  await expect(preview).toBeVisible();
  await page.goBack();
  await expect(preview).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/dynamics/${manyId}$`));
  await expect(detailTrigger).toBeFocused();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect(page).toHaveURL(url);
});

test('预览按需请求单张原图，缩略图真实懒加载，签名形式 URL 保持完整', async ({ page }) => {
  // 卡片去掉归档/多余底距后更紧凑；控制视口让末图仍在原生lazy预取距离之外。
  await page.setViewportSize({ ...page.viewportSize()!, height: 400 });
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/demo-images/')) requests.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(10);
  const lateThumbnail = '/demo-images/landscape-12-thumb.v1.png';
  expect(requests.filter(url => url.includes('-preview.'))).toEqual([]);
  expect(requests.some(url => url.includes(lateThumbnail))).toBe(false);
  const signedThumbnail = '/demo-images/landscape-1-thumb.v1.png?signature=demo%2Fonly&expires=123';
  await expect.poll(() => requests.some(url => url.endsWith(signedThumbnail))).toBe(true);
  const late = page.getByRole('article').filter({ has: page.getByText('图文日记 9', { exact: false }) });
  await late.scrollIntoViewIfNeeded();
  await expect.poll(() => requests.some(url => url.includes(lateThumbnail))).toBe(true);
  const card = page.getByRole('article').filter({ has: page.getByText('图文日记 4', { exact: false }) });
  await card.getByRole('button', { name: '预览图片 1', exact: true }).click();
  const preview = page.getByRole('dialog');
  const first = preview.getByRole('img');
  await expect.poll(() => first.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(1200);
  const signedPreview = '/demo-images/landscape-1-preview.v1.png?signature=demo%2Fonly&expires=123';
  expect(requests.filter(url => url.includes('-preview.'))).toEqual([new URL(signedPreview, page.url()).href]);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => requests.filter(url => url.includes('-preview.')).length).toBe(2);
  expect(requests.some(url => url.includes('landscape-3-preview'))).toBe(false);
  // 请求发起不代表图片已解码；实际比例须在当前图加载完成后测量。
  await expect.poll(() => first.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(1200);
  const box = await first.boundingBox();
  expect(box!.width / box!.height).toBeCloseTo(4 / 3, 1);
  await page.keyboard.press('Escape');
});

test('同一预览历史记录再次可达时仍能按钮和 Esc 关闭，不被重复关闭守卫困住', async ({ page }) => {
  await page.goto(`/dynamics/${fourId}`);
  const trigger = page.getByRole('button', { name: '预览图片 1', exact: true });
  const preview = page.getByRole('dialog');
  await trigger.click();
  await preview.getByRole('button', { name: '关闭预览' }).click();
  await expect(preview).toHaveCount(0);
  await page.goForward();
  await expect(preview).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/dynamics/${fourId}$`));
  await page.goForward();
  await expect(preview).toBeVisible();
  await preview.getByRole('button', { name: '关闭预览' }).click();
  await expect(preview).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('资源失败在内容图局部重试原 URL，坏图不阻断切图和关闭，头像单独回退', async ({ page }) => {
  let thumbnailAttempts = 0;
  let previewAttempts = 0;
  const retried: string[] = [];
  await page.route('**/creator-avatar.v1.svg', route => route.abort());
  await page.route('**/landscape-1-thumb.v1.png*', route => {
    retried.push(route.request().url());
    return ++thumbnailAttempts === 1 ? route.abort() : route.continue();
  });
  await page.route('**/landscape-1-preview.v1.png*', route => {
    return ++previewAttempts === 1 ? route.abort() : route.continue();
  });
  await page.goto(`/dynamics/${fourId}`);
  const card = page.getByRole('article');
  await expect(card.getByText('图片加载失败')).toBeVisible();
  await expect(card.getByRole('img', { name: '纸飞机的头像' })).toHaveAttribute('src', '/default-avatar.svg');
  await card.getByRole('button', { name: '重试图片 1', exact: true }).click();
  await expect(card.getByText('图片加载失败')).toHaveCount(0);
  await expect.poll(() => card.getByRole('img', { name: '图片 1', exact: true }).evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(240);
  expect(retried).toHaveLength(2);
  expect(retried[0]).toBe(retried[1]);
  await card.getByRole('button', { name: '预览图片 1', exact: true }).click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('图片加载失败')).toBeVisible();
  const retry = preview.getByRole('button', { name: '重试预览图片 1' });
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await retry.click();
  await expect(preview.getByText('图片加载失败')).toHaveCount(0);
  await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(1200);
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByText('2 / 4')).toBeVisible();
  await preview.getByRole('button', { name: '关闭预览' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${fourId}$`));
  await expect(card.getByRole('button', { name: '预览图片 1', exact: true })).toBeFocused();
});

test('单图预览隐藏切换入口、完整等比显示；关闭后滚动锁解除', async ({ page }) => {
  await page.goto(`/dynamics/${singleId}`);
  const trigger = page.getByRole('button', { name: '预览图片 1', exact: true });
  await trigger.click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('1 / 1')).toBeVisible();
  await expect(preview.getByRole('button', { name: /上一张|下一张/ })).toHaveCount(0);
  await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(1200);
  const box = await preview.getByRole('img').boundingBox();
  expect(box!.width / box!.height).toBeCloseTo(4 / 3, 1);
  expect(box!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect(box!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
  await page.keyboard.press('Tab');
  await expect(preview.getByRole('button', { name: '关闭预览' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(preview.getByRole('button', { name: '关闭预览' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByText('1 / 1')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

test('缺尺寸缩略图先占位，加载后使用实际比例；预览加载中有提示', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/landscape-11-thumb.v1.png', async route => { await pending; await route.continue(); });
  await page.goto(`/dynamics/${unknownSizeId}`);
  const thumbnail = page.getByRole('img', { name: '图片 1', exact: true });
  const button = page.getByRole('button', { name: '预览图片 1', exact: true });
  await expect(button).toBeVisible();
  const reserved = await button.boundingBox();
  expect(reserved!.height).toBeGreaterThan(44);
  release();
  await expect.poll(() => thumbnail.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(240);
  await expect.poll(async () => { const box = await thumbnail.boundingBox(); return box!.width / box!.height; }).toBeCloseTo(2, 1);
  // 实际比例更新发生在框内；占位外框不得在迟到加载后移动下方阅读内容。
  const loadedFrame = await button.boundingBox();
  expect(loadedFrame!.height).toBeCloseTo(reserved!.height, 1);
  expect(loadedFrame!.width).toBeCloseTo(reserved!.width, 1);
  let releasePreview!: () => void;
  const previewPending = new Promise<void>(resolve => { releasePreview = resolve; });
  await page.route('**/landscape-11-preview.v1.png', async route => { await previewPending; await route.continue(); });
  await button.click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('图片加载中')).toBeVisible();
  releasePreview();
  await expect(preview.getByText('图片加载中')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('单图、四图、九图、超九图的真实缩略素材与四种视口布局', async ({ page }) => {
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [id, count, columns] of [[singleId, 1, 1], [fourId, 4, 2], [nineId, 9, 3], [manyId, 12, 3]] as const) {
      await page.goto(`/dynamics/${id}`);
      const images = page.getByRole('group', { name: '动态图片' });
      await expect(images.getByRole('img')).toHaveCount(count);
      const boxes = await Promise.all((await images.getByRole('button', { name: /^预览图片/ }).all())
        .map(button => button.boundingBox()));
      expect(boxes.filter(box => box && Math.abs(box.y - boxes[0]!.y) < 1)).toHaveLength(columns);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const first = images.getByRole('img').first();
      await expect.poll(() => first.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBeGreaterThan(0);
      expect(await first.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBeLessThanOrEqual(240);
      const buttonBox = await images.getByRole('button', { name: '预览图片 1', exact: true }).boundingBox();
      expect(buttonBox?.width).toBeGreaterThanOrEqual(44);
      expect(buttonBox?.height).toBeGreaterThanOrEqual(44);
      if (count === 1) {
        const box = await first.boundingBox();
        expect(box!.width / box!.height).toBeCloseTo(4 / 3, 1);
      }
    }
  }
  await page.goto('/');
  const many = page.getByRole('article').filter({ has: page.getByText('图文日记 6', { exact: false }) });
  await expect(many.getByRole('img', { name: /^图片/ })).toHaveCount(9);
  await expect(many.getByText('+3', { exact: true })).toBeVisible();
});
