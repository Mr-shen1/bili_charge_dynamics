import { expect, test } from '@playwright/test';
import { installMediaHttp } from './fixtures/media-http';
import { installCommentMediaHttp } from './fixtures/comment-media-http';

test('列表与详情直接去掉归档文字块，保留正文、发布时间与评论入口', async ({ page }) => {
  await installMediaHttp(page);
  await page.goto('/');
  const card = page.getByRole('article').filter({ has: page.getByText('纯文字 1006', { exact: true }) });
  await expect(card).toBeVisible();
  await expect(card.getByRole('complementary', { name: '归档状态', exact: true })).toHaveCount(0);
  await expect(card).not.toContainText(/编辑于|编辑信号|本地已归档|正文已保存|媒体已归档/);
  await expect(card.getByText('2026-03-01 10:03:04', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '来源评论 501', exact: true }).click();
  await expect(page).toHaveURL(/\/dynamics\/1006$/);
  const detail = page.getByRole('article');
  await expect(detail.getByText('纯文字 1006', { exact: true })).toBeVisible();
  await expect(detail.getByRole('complementary', { name: '归档状态', exact: true })).toHaveCount(0);
  await expect(detail).not.toContainText(/编辑于|编辑信号|本地已归档|正文已保存|媒体已归档/);
  await expect(detail.getByText('2026-03-01 10:03:04', { exact: true })).toBeVisible();
  await expect(detail.getByRole('button', { name: /评论/ })).toHaveCount(0);
  await expect(detail).not.toContainText(/(?:来源)?评论\s*501/);
  const comments = page.getByRole('region', { name: '评论区', exact: true });
  await expect(comments).toBeVisible();
  await expect(comments.getByRole('heading', { name: '评论 501', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '来源评论 501', exact: true })).toHaveCount(1);
  await expect(comments.getByRole('button', { name: '来源评论 501', exact: true })).toBeVisible();
});

// Expected measurements come from the user reference, not an implementation snapshot.
test('参考阅读主栏、身份和轻量评论入口；四宽度不溢出', async ({ page }) => {
  await installMediaHttp(page);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    const main = page.getByRole('main');
    const card = page.getByRole('article').first();
    await expect(card).toBeVisible();
    const mainBox = (await main.boundingBox())!;
    // 裁剪来源侧栏后，独立列表采用当前1920视口的724px阅读列。
    expect(mainBox.width).toBe(Math.min(width, 724));
    const avatar = card.getByRole('img', { name: '归档作者的头像', exact: true });
    const avatarBox = (await avatar.boundingBox())!;
    const identityCard = (await card.boundingBox())!;
    expect(avatarBox.width).toBe(48);
    expect(avatarBox.x - identityCard.x).toBe(width <= 480 ? 12 : 20);
    expect(avatarBox.y - identityCard.y).toBe(width <= 480 ? 16 : 20);
    await expect(card.getByText('2026-03-01 10:03:04', { exact: true })).toHaveCSS('font-size', '13px');
    await expect(card.getByText('2026-03-01 10:03:04', { exact: true })).toHaveCSS('line-height', '18px');
    const entry = card.getByRole('button', { name: '来源评论 501', exact: true });
    await expect(entry).toBeVisible();
    const entryBox = (await entry.boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(entryBox.height).toBeGreaterThanOrEqual(44);
    // 新用户卡片图气泡居中；不为已裁剪转发/点赞留两个空控件槽。
    expect(entryBox.x + entryBox.width / 2).toBeCloseTo(cardBox.x + cardBox.width / 2, 0);
    const appearance = await entry.evaluate(element => {
      const style = getComputedStyle(element);
      return { border: style.borderTopWidth, background: style.backgroundColor };
    });
    expect(appearance).toEqual({ border: '0px', background: 'rgba(0, 0, 0, 0)' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await entry.click();
    await expect(page).toHaveURL(/\/dynamics\/1001$/);
    await expect(page.getByRole('heading', { name: /^评论/ })).toBeVisible();
    const sort = page.getByRole('group', { name: '评论排序' });
    const hot = sort.getByRole('button', { name: '最热', exact: true });
    const latest = sort.getByRole('button', { name: '最新', exact: true });
    expect((await hot.boundingBox())!.y).toBe((await latest.boundingBox())!.y);
    expect(await hot.evaluate(element => getComputedStyle(element).borderTopWidth)).toBe('0px');
    await latest.click();
    await expect(latest).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('评论为白底平面行且图像不裁切；长身份不会与正文重叠', async ({ page }) => {
  await installCommentMediaHttp(page);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dynamics/1004');
    const row = page.locator('[data-reading-id="comment:2002"]');
    await expect(row).toBeVisible();
    const author = row.getByText(/^长昵称/);
    const text = row.getByText('四图评论正文', { exact: true });
    const authorBox = (await author.boundingBox())!;
    const textBox = (await text.boundingBox())!;
    expect(textBox.y).toBeGreaterThanOrEqual(authorBox.y + authorBox.height);
    expect(textBox.x).toBe(authorBox.x);
    const appearance = await row.evaluate(element => {
      const style = getComputedStyle(element);
      return { radius: style.borderRadius, background: style.backgroundColor };
    });
    expect(appearance).toEqual({ radius: '0px', background: 'rgba(0, 0, 0, 0)' });
    for (const image of await row.getByRole('img', { name: /^图片/ }).all()) {
      await expect(image).toHaveCSS('object-fit', 'contain');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
