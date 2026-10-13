import { expect, test, type Page } from '@playwright/test';

const fourId = '90071992547409934';
const manyId = '90071992547409936';
const singleId = '90071992547409932';

// Chromium CDP 输入真实 touch 事件，交给浏览器产生 PointerEvent 和原生纵向滚动；不是 DOM dispatchEvent。
async function swipe(page: Page, dx: number, dy: number) {
  const stage = (await page.getByRole('region', { name: '预览图片阅读区域' }).boundingBox())!;
  const x = stage.x + stage.width / 2;
  const y = stage.y + stage.height / 2;
  const input = await page.context().newCDPSession(page);
  await input.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  for (let step = 1; step <= 10; step++) {
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 10, y: y + dy * step / 10, id: 1 }] });
    await page.waitForTimeout(20); // 给原生触摸滚动连续输入帧，不用延迟猜测断言结果。
  }
  await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await input.detach();
}

test('触摸横向切图不循环、单图不切换；长图纵向原生阅读不误切图且不滚动底层', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`/dynamics/${fourId}`);
  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  const preview = page.getByRole('dialog');
  await swipe(page, 110, 5);
  await expect(preview.getByText('1 / 4')).toBeVisible();
  await swipe(page, -110, 5);
  await expect(preview.getByText('2 / 4')).toBeVisible();
  await swipe(page, -110, 5);
  await swipe(page, -110, 5);
  await swipe(page, -110, 5);
  await expect(preview.getByText('4 / 4')).toBeVisible();
  await swipe(page, 110, 5);
  await expect(preview.getByText('3 / 4')).toBeVisible();
  await page.goBack();
  await expect(preview).toHaveCount(0);

  await page.goto(`/dynamics/${manyId}`);
  const trigger = page.getByRole('button', { name: '预览图片 12', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  const mainTop = (await page.locator('main').boundingBox())!.y;
  await trigger.click();
  await preview.getByRole('button', { name: '适应宽度' }).click();
  await swipe(page, -35, -220);
  const stage = preview.getByRole('region', { name: '预览图片阅读区域' });
  await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
  await expect(preview.getByText('12 / 12')).toBeVisible();
  expect((await page.locator('main').boundingBox())!.y).toBeCloseTo(mainTop, 0);
  await swipe(page, 110, 5);
  await expect(preview.getByText('11 / 12')).toBeVisible();
  expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
  expect((await page.locator('main').boundingBox())!.y).toBeCloseTo(mainTop, 0);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y);

  await page.goto(`/dynamics/${singleId}`);
  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  await swipe(page, -110, 5);
  await swipe(page, 110, 5);
  await expect(preview.getByText('1 / 1')).toBeVisible();
  await preview.getByRole('button', { name: '关闭预览' }).click();
  await expect(preview).toHaveCount(0);
});

test('缺尺寸图片加载后识别长图，仍可切换适宽阅读', async ({ page }) => {
  await page.route('**/landscape-11-preview.v1.png', route => route.fulfill({
    contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1600"><rect width="600" height="1600" fill="#475569"/></svg>',
  }));
  await page.goto('/dynamics/90071992547409937');
  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  const preview = page.getByRole('dialog');
  await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalHeight)).toBe(1600);
  await preview.getByRole('button', { name: '适应宽度' }).click();
  await expect(preview.getByRole('button', { name: '完整显示' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
});

test('长图完整等比、适宽纵向阅读不动底层；切图归零，前进保留模式，四宽度键盘可用', async ({ page }) => {
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/dynamics/${manyId}`);
    const trigger = page.getByRole('button', { name: '预览图片 12', exact: true });
    await trigger.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    const mainTop = (await page.locator('main').boundingBox())!.y;
    await trigger.click();
    const preview = page.getByRole('dialog');
    await expect(preview).toBeVisible();
    const openedLength = await page.evaluate(() => history.length);
    const stage = preview.getByRole('region', { name: '预览图片阅读区域' });
    const image = preview.getByRole('img');
    await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.naturalHeight)).toBe(1600);
    const whole = (await image.boundingBox())!;
    const bounds = (await stage.boundingBox())!;
    expect(whole.width / whole.height).toBeCloseTo(600 / 1600, 2);
    expect(whole.height).toBeLessThanOrEqual(bounds.height);
    await preview.getByRole('button', { name: '适应宽度' }).focus();
    await page.keyboard.press('Enter');
    await expect(preview.getByRole('button', { name: '完整显示' })).toBeFocused();
    const wide = (await image.boundingBox())!;
    expect(wide.width).toBeCloseTo(bounds.width, 0);
    expect(wide.height).toBeGreaterThan(bounds.height);
    await stage.hover();
    await page.mouse.wheel(0, 450);
    await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBeGreaterThan(200);
    expect((await page.locator('main').boundingBox())!.y).toBeCloseTo(mainTop, 0);
    await page.keyboard.press('ArrowLeft');
    await expect(preview.getByText('11 / 12')).toBeVisible();
    await expect(preview.getByRole('button', { name: /适应宽度|完整显示/ })).toHaveCount(0);
    expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect(preview.getByRole('button', { name: '完整显示' })).toBeVisible();
    expect(await stage.evaluate(element => element.scrollTop)).toBe(0);
    expect(await page.evaluate(() => history.length)).toBe(openedLength);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
    await page.goForward();
    await expect(preview.getByText('12 / 12')).toBeVisible();
    await expect(preview.getByRole('button', { name: '完整显示' })).toBeVisible();
    await page.goBack();
    await expect(preview).toHaveCount(0);
  }
});

test('重复开关和替换路由key保留底层阅读与同一预览，快速按钮/Esc意图只关闭一次', async ({ page }) => {
  await page.goto('/?view=reader#local');
  await page.getByRole('article').first().getByRole('button', { name: '展开正文' }).click();
  await page.getByRole('button', { name: '加载更多' }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  const card = page.getByRole('article').filter({ has: page.getByText('图文日记 4', { exact: false }) });
  const trigger = card.getByRole('button', { name: '预览图片 1', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const y = await page.evaluate(() => scrollY);
  const url = page.url();
  const preview = page.getByRole('dialog');
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    await expect(preview.getByText('1 / 4')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(preview.getByText('2 / 4')).toBeVisible();
    await page.evaluate(key => {
      history.replaceState({ ...history.state, key }, '', location.href);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, `replacement-${attempt}`);
    await expect(preview.getByText('2 / 4')).toBeVisible();
    await preview.getByRole('button', { name: '关闭预览' }).evaluate(button => {
      if (button instanceof HTMLButtonElement) { button.click(); button.click(); }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(preview).toHaveCount(0);
    expect(page.url()).toBe(url);
    await expect(page.getByRole('article')).toHaveCount(20);
    await expect(page.getByRole('article').first().getByRole('button', { name: '收起正文' })).toHaveCount(1);
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
    await page.goForward();
    await expect(preview.getByText('2 / 4')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.goBack();
    await expect(preview).toHaveCount(0);
    await page.goForward();
    await expect(preview.getByText('3 / 4')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
  }
});

test('从底层开始新导航分支后不虚构已丢弃的前进预览，新开预览独立初始化', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('article').filter({ has: page.getByText('图文日记 4', { exact: false }) });
  const trigger = card.getByRole('button', { name: '预览图片 1', exact: true });
  await trigger.click();
  const preview = page.getByRole('dialog');
  await expect(preview.getByText('1 / 4')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(preview.getByText('2 / 4')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await card.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(new RegExp(`/dynamics/${fourId}$`));
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(preview).toHaveCount(0);
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${fourId}$`));
  await page.goForward();
  await expect(preview).toHaveCount(0);
  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  await expect(preview.getByText('1 / 4')).toBeVisible();
  await page.goBack();
  await expect(preview).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/dynamics/${fourId}$`));
});

for (const marker of ['missing-preview', null]) {
  test(`当前页面有效但预览引用 ${String(marker)} 失效时替换清理，保留底层阅读状态`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(20);
    const trigger = page.getByRole('article').filter({ has: page.getByText('图文日记 4', { exact: false }) })
      .getByRole('button', { name: '预览图片 1', exact: true });
    await trigger.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    const length = await page.evaluate(() => history.length);
    // 从浏览器 History 边界模拟遗留/损坏引用，不注入 React 状态或新增测试 API。
    await page.evaluate(previewId => {
      history.replaceState({ ...history.state, key: 'legacy-metadata', usr: { ...history.state.usr, previewId } }, '', location.href);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, marker);
    await expect.poll(() => page.evaluate(() => history.state.usr?.previewId)).toBeUndefined();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('article')).toHaveCount(20);
    expect(await page.evaluate(() => history.length)).toBe(length);
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });
}

for (const path of ['/', `/dynamics/${fourId}`]) {
  test(`预览中刷新 ${path} 仅替换降级，遗留前后记录不产生空弹层或循环`, async ({ page }) => {
    await page.goto(path);
    const card = path === '/' ? page.getByRole('article').filter({ has: page.getByText('图文日记 4', { exact: false }) }) : page.getByRole('article');
    await card.getByRole('button', { name: '预览图片 1', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const length = await page.evaluate(() => history.length);
    await page.reload();
    await expect(page.getByRole('article').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => history.state.usr?.previewId)).toBeUndefined();
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.goBack();
    await expect(page.getByRole('article').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goForward();
    await expect(page.getByRole('article').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await card.getByRole('button', { name: '预览图片 1', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    expect(await page.evaluate(() => document.body.style.position)).not.toBe('fixed');
  });


  test(`从 ${path} 切图关闭后前进恢复最后图片，再后退只关预览`, async ({ page }) => {
    await page.goto(path);
    const card = path === '/' ? page.getByRole('article').filter({ has: page.getByText('图文日记 4', { exact: false }) }) : page.getByRole('article');
    const trigger = card.getByRole('button', { name: '预览图片 1', exact: true });
    await trigger.scrollIntoViewIfNeeded();
    const y = await page.evaluate(() => scrollY);
    const url = page.url();
    const length = await page.evaluate(() => history.length);
    await trigger.click();
    const preview = page.getByRole('dialog');
    await preview.getByRole('button', { name: '下一张' }).click();
    await page.keyboard.press('ArrowRight');
    await expect(preview.getByText('3 / 4')).toBeVisible();
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    await preview.getByRole('button', { name: '关闭预览' }).click();
    await expect(preview).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.goForward();
    await expect(preview.getByText('3 / 4')).toBeVisible();
    await page.goBack();
    await expect(preview).toHaveCount(0);
    expect(page.url()).toBe(url);
    await expect(trigger).toBeFocused();
    await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(y, 0);
  });
}
