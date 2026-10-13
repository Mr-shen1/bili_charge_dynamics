import { expect, test } from '@playwright/test';

const firstId = '90071992547409931';

test('整卡留白和键盘阅读全文，气泡定位评论；身份、选择正文、展开和看图不误导航', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('article').first();
  const entry = card.getByRole('link', { name: `阅读全文 ${firstId}`, exact: true });
  await expect(entry).toHaveAttribute('href', `/dynamics/${firstId}`);
  await expect(page.getByRole('button', { name: '查看详情', exact: true })).toHaveCount(0);
  await expect(card.getByRole('link')).toHaveCount(1);

  await card.getByText('纸飞机', { exact: true }).click();
  await card.getByRole('img', { name: '纸飞机的头像', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await card.getByRole('button', { name: '展开正文', exact: true }).click();
  await expect(card.getByRole('button', { name: '收起正文', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  // 按真实文本坐标拖选，不用 JS 注入 Selection 绕过覆盖层和浏览器命中测试。
  const text = card.locator('p').first();
  const selection = await text.evaluate(element => {
    const node = element.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error('Expected readable text');
    const start = document.createRange();
    start.setStart(node, 0);
    start.setEnd(node, 1);
    const end = document.createRange();
    end.setStart(node, 4);
    end.setEnd(node, 5);
    const a = start.getBoundingClientRect();
    const b = end.getBoundingClientRect();
    return { start: { x: a.left + 1, y: a.top + a.height / 2 }, end: { x: b.right - 1, y: b.top + b.height / 2 } };
  });
  await page.mouse.move(selection.start.x, selection.start.y);
  await page.mouse.down();
  await page.mouse.move(selection.end.x, selection.end.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().length ?? 0)).toBeGreaterThan(1);
  await expect(page).toHaveURL(/\/$/);
  // 点击只展示的身份清除刚才的选区，为后续独立点击恢复普通浏览状态。
  await card.getByText('纸飞机', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed ?? true)).toBe(true);
  await expect(page).toHaveURL(/\/$/);

  const image = card.getByRole('button', { name: '预览图片 1', exact: true });
  await image.click();
  const preview = page.getByRole('dialog', { name: '图片预览', exact: true });
  await expect(preview).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(image).toBeFocused();

  // 点击卡片左上角内侧留白，而不是对 link 调用 DOM click。
  await card.evaluate(element => element.scrollIntoView({ block: 'start' }));
  const box = (await card.boundingBox())!;
  await page.mouse.click(box.x + 8, box.y + 8);
  await expect(page).toHaveURL(new RegExp(`/dynamics/${firstId}$`));
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(card.getByRole('button', { name: '收起正文', exact: true })).toHaveCount(1);

  const comments = card.getByRole('button', { name: '评论 70', exact: true });
  const bubble = comments.locator('svg');
  await expect(bubble).toBeVisible();
  await expect(bubble).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.press('Tab');
  await comments.focus();
  await expect(comments).toBeFocused();
  expect(await comments.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  const commentBox = (await comments.boundingBox())!;
  expect(commentBox.width).toBeGreaterThanOrEqual(44);
  expect(commentBox.height).toBeGreaterThanOrEqual(44);
  await bubble.click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${firstId}$`));
  await expect.poll(() => page.getByRole('region', { name: '评论区', exact: true }).evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(0, 0);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();

  // 从列表主区域沿真实 Tab 顺序到达独立 link，不假定其位于内嵌操作前或后。
  await page.getByRole('main').focus();
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press('Tab');
    if (await entry.evaluate(element => element === document.activeElement)) break;
  }
  await expect(entry).toBeFocused();
  expect(await entry.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
  const entryBox = (await entry.boundingBox())!;
  expect(entryBox.width).toBeGreaterThanOrEqual(44);
  expect(entryBox.height).toBeGreaterThanOrEqual(44);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/dynamics/${firstId}$`));
  // 主动 link 入口覆盖前一次评论入口的滚动位置。
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
});
