import { expect, test, type Locator, type Page } from '@playwright/test';

const firstId = '90071992547409931';
const locate = (anchor: Locator) => anchor.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 40));
const top = (anchor: Locator) => anchor.evaluate(element => element.getBoundingClientRect().top);

async function checkLayoutAndTargets(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // 检查全部已展开内容，不只检查首屏；记录越界元素以定位公开布局缺陷。
  const overflow = await page.locator('main article, main li, main p, main img').evaluateAll(elements => elements
    .filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.left < -1 || box.right > innerWidth + 1);
    }).map(element => ({ tag: element.tagName, text: element.textContent?.slice(0, 80) })));
  expect(overflow).toEqual([]);
  await checkTargets(page);
}

async function checkTargets(page: Page) {
  const smallTargets = await page.getByRole('button').evaluateAll(elements => elements
    .filter(element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.width < 44 || box.height < 44);
    }).map(element => element.textContent));
  expect(smallTargets).toEqual([]);
}

for (const width of [360, 390, 768, 1280]) {
  test(`${width}px 完整只读流程：列表 → 详情 → 看图 → 排序 → 展开回复 → 返回恢复`, async ({ page }) => {
    const unexpectedRequests: string[] = [];
    page.on('request', request => {
      if (request.method() !== 'GET' || new URL(request.url()).origin !== 'http://127.0.0.1:4173') unexpectedRequests.push(`${request.method()} ${request.url()}`);
    });
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(10);
    const card = page.getByRole('article').first();
    await card.getByRole('button', { name: '展开正文', exact: true }).click();
    for (const count of [20, 25]) {
      await page.getByRole('button', { name: '加载更多', exact: true }).click();
      await expect(page.getByRole('article')).toHaveCount(count);
    }
    await expect(page.getByText('动态已加载完毕', { exact: true })).toBeVisible();
    await checkLayoutAndTargets(page);
    await locate(card);
    const listOffset = await top(card);
    // 按现有历史测试接缝触发公开链接，避免 Playwright 自动滚动改写待保存的位置。
    await card.getByRole('link', { name: /^阅读全文 / }).evaluate(element => (element as HTMLAnchorElement).click());
    await expect(page).toHaveURL(new RegExp(`/dynamics/${firstId}$`));
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await expect(page.getByRole('article')).toContainText('第八行');
    const trigger = page.getByRole('button', { name: '预览图片 1', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const preview = page.getByRole('dialog', { name: '图片预览' });
    await expect(preview.getByText('1 / 1', { exact: true })).toBeVisible();
    await expect.poll(() => preview.getByRole('img').evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBeGreaterThan(0);
    await checkTargets(page);
    await page.keyboard.press('Tab');
    await expect(preview.getByRole('button', { name: '关闭预览' })).toBeFocused();
    expect(await preview.getByRole('button', { name: '关闭预览' }).evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(trigger).toBeFocused();

    const area = page.getByRole('region', { name: '评论区', exact: true });
    const rows = area.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
    await expect(rows).toHaveCount(20);
    await area.getByRole('button', { name: '最新', exact: true }).click();
    await expect(rows.first()).toContainText('长评论 1');
    await expect(area.getByRole('button', { name: '最新', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await area.getByRole('button', { name: '最热', exact: true }).click();
    await expect(rows.first()).toContainText('长评论 45');
    await rows.first().getByRole('button', { name: '展开评论', exact: true }).click();
    const replies = page.getByRole('region', { name: '回复区 comment-44', exact: true });
    await expect(replies.getByRole('listitem')).toHaveCount(3);
    await replies.getByRole('listitem').first().getByRole('button', { name: '展开回复正文', exact: true }).click();
    await replies.getByRole('button', { name: '展开回复', exact: true }).click();
    await expect(replies.getByRole('listitem')).toHaveCount(13);
    for (const count of [23, 25]) {
      await replies.getByRole('button', { name: '加载更多回复', exact: true }).click();
      await expect(replies.getByRole('listitem')).toHaveCount(count);
    }
    for (const count of [40, 45]) {
      await area.getByRole('button', { name: '加载更多评论', exact: true }).click();
      await expect(rows).toHaveCount(count);
    }
    await expect(page.getByRole('region', { name: '评论区', exact: true }).getByRole('button', { name: '评论 70', exact: true })).toBeVisible();
    await checkLayoutAndTargets(page);
    const anchor = replies.getByRole('listitem').nth(8);
    const anchorText = await anchor.textContent();
    await locate(anchor);
    const detailOffset = await top(anchor);
    await page.getByRole('button', { name: '返回列表', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('article')).toHaveCount(25);
    await expect(card.getByRole('button', { name: '收起正文', exact: true })).toHaveCount(1);
    await expect.poll(() => top(card)).toBeCloseTo(listOffset, 0);
    await page.goForward();
    await expect(rows).toHaveCount(45);
    await expect(replies.getByRole('listitem')).toHaveCount(25);
    await expect(area.getByRole('button', { name: '最热', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows.first().getByRole('button', { name: '收起评论', exact: true })).toHaveCount(1);
    await expect(replies.getByRole('listitem').first().getByRole('button', { name: '收起回复正文', exact: true })).toHaveCount(1);
    await expect(anchor).toHaveText(anchorText!);
    await expect(anchor).toBeInViewport();
    await expect.poll(() => top(anchor)).toBeCloseTo(detailOffset, 0);
    await checkLayoutAndTargets(page);
    expect(unexpectedRequests).toEqual([]);
    await expect(page.locator('form, input, textarea')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^(点赞|发布|发送|转发|购买|解锁|关注|故障)/ })).toHaveCount(0);
    await expect(page.getByText(/简介|充电|故障控制/)).toHaveCount(0);
  });
}

test.describe('切换设备时区为 UTC', () => {
  test.use({ timezoneId: 'UTC' });
  test('列表、评论和回复仍显示北京时间秒值与完整总数', async ({ page }) => {
    await page.goto('/');
    const card = page.getByRole('article').first();
    await expect(card.getByText('2026-03-01 10:03:04', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: '评论 70', exact: true })).toBeVisible();
    await card.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
    const area = page.getByRole('region', { name: '评论区', exact: true });
    const root = area.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li').first();
    await expect(root.getByText('2026-03-01 10:16:00', { exact: true })).toBeVisible();
    await expect(root.getByText('回复 25', { exact: true })).toBeVisible();
    const reply = page.getByRole('region', { name: '回复区 comment-44', exact: true }).getByRole('listitem').first();
    await expect(reply.getByText('2026-03-01 12:00:00', { exact: true })).toBeVisible();
    await expect(reply.getByRole('group', { name: '点赞 0', exact: true })).toBeVisible();
  });
});

test('四种宽度的完整列表直接验证单图比例、四图两列、九/十二图三列与九格上限', async ({ page }) => {
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    for (const count of [20, 25]) {
      await page.getByRole('button', { name: '加载更多', exact: true }).click();
      await expect(page.getByRole('article')).toHaveCount(count);
    }
    for (const [label, count, columns] of [['2026-02-28 10:03:04', 1, 1], ['图文日记 4', 4, 2], ['图文日记 5', 9, 3], ['图文日记 6', 9, 3]] as const) {
      const card = page.getByRole('article').filter({ hasText: label });
      const images = card.getByRole('group', { name: '动态图片' });
      await images.scrollIntoViewIfNeeded();
      const buttons = images.getByRole('button', { name: /^预览图片/ });
      await expect(buttons).toHaveCount(count);
      const boxes = await Promise.all((await buttons.all()).map(button => button.boundingBox()));
      expect(boxes.filter(box => box && Math.abs(box.y - boxes[0]!.y) < 1)).toHaveLength(columns);
      if (count === 1) {
        const image = images.getByRole('img');
        await expect.poll(() => image.evaluate(element => element instanceof HTMLImageElement && element.naturalWidth)).toBe(240);
        const box = (await image.boundingBox())!;
        expect(box.width / box.height).toBeCloseTo(4 / 3, 1);
      }
      if (label === '图文日记 6') {
        await expect(images.getByText('+3', { exact: true })).toBeVisible();
        await buttons.last().click();
        const preview = page.getByRole('dialog', { name: '图片预览' });
        await expect(preview.getByText('9 / 12', { exact: true })).toBeVisible();
        for (let step = 0; step < 3; step++) await preview.getByRole('button', { name: '下一张', exact: true }).click();
        await expect(preview.getByText('12 / 12', { exact: true })).toBeVisible();
        await expect(preview.getByRole('button', { name: '适应宽度', exact: true })).toBeVisible();
        await checkTargets(page);
        await preview.getByRole('button', { name: '适应宽度', exact: true }).click();
        await expect(preview.getByRole('button', { name: '完整显示', exact: true })).toBeVisible();
        await checkTargets(page);
        await page.keyboard.press('Escape');
        await expect(preview).toHaveCount(0);
        await expect(buttons.last()).toBeFocused();
      }
    }
    await checkLayoutAndTargets(page);
  }
});
