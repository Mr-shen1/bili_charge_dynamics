// @projects desktop-chromium-archive, mobile-chromium-archive
import { expect, test, type Page } from '@playwright/test';

// 一级评论跑生产装配 + HTTP 传输替身：仍经过真实 Adapter 的 DTO 映射与页面读取，
// 请求次数、排序与 cursor 可直接观察。折叠、锚点、布局变化必须真实浏览器。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const longText = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：这是一段足够长的评论正文，用于验证实际超过六行才折叠。`).join('\n');
// 短行在 360px 宽度下也不会折行：六行恰好等于折叠阈值，七行才应出现展开入口。
const sixLines = Array.from({ length: 6 }, (_value, line) =>
  `第六行边界 ${line + 1}：短行`).join('\n');

function archiveTime(index: number): string {
  const epoch = Date.UTC(2026, 2, 1, 2, 3, 4) - index * 3_600_000 + 8 * 3_600_000;
  return `${new Date(epoch).toISOString().slice(0, 19)}+08:00`;
}

function dynamic() {
  return {
    id: '1001',
    author,
    published_at: '2026-03-01T10:03:04+08:00',
    edit_status: 'unknown',
    text: '详情正文',
    content_state: 'success',
    last_attempt: 'success',
    source_comment_count: 45,
    local_comment_count: 45,
    media_sources: [],
    comment_locator: null,
    observed_version: null,
    synced_version: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    root_comments_last_attempt: 'success',
  };
}

function comment(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(7000 + index),
    dynamic_id: '1001',
    author: commenter,
    published_at: archiveTime(index),
    text: `一级评论 ${index}`,
    like_count: (index * 37) % 23,
    source_reply_count: 0,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
    ...overrides,
  };
}

const all = Array.from({ length: 45 }, (_value, index) => comment(index + 1, {
  is_pinned: index === 0,
  text: index === 0 ? longText : index === 1 ? sixLines : `一级评论 ${index + 1}`,
}));

function ordered(items: readonly ReturnType<typeof comment>[], sort: 'hot' | 'latest') {
  const time = (item: ReturnType<typeof comment>): number => Date.parse(item.published_at);
  const likes = (item: ReturnType<typeof comment>): number => item.like_count;
  return [...items].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    if (sort === 'hot' && likes(a) !== likes(b)) return likes(b) - likes(a);
    if (time(a) !== time(b)) return time(b) - time(a);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

type Reply = { status?: number; body: unknown };
type CommentRequest = { sort: string | null; cursor: string | null };

async function mockApi(
  page: Page,
  options: { delay?: (request: CommentRequest) => number; commentItems?: readonly ReturnType<typeof comment>[] } = {},
) {
  const requests: CommentRequest[] = [];
  const items = options.commentItems ?? all;
  const orders = { hot: ordered(items, 'hot'), latest: ordered(items, 'latest') };
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const reply = (body: unknown, status = 200): Reply => ({ status, body });
    let result: Reply;
    if (url.pathname === '/api/archive/ups') {
      result = reply({ ups: [author] });
    } else if (url.pathname === '/api/archive/dynamics') {
      result = reply({ items: [dynamic()], next_cursor: null });
    } else if (url.pathname === '/api/archive/dynamics/1001') {
      result = reply(dynamic());
    } else if (/\/api\/archive\/dynamics\/1001\/comments$/.test(url.pathname)) {
      const sort = url.searchParams.get('sort');
      const cursor = url.searchParams.get('cursor');
      requests.push({ sort, cursor });
      const delay = options.delay?.({ sort, cursor }) ?? 0;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      const list = orders[sort === 'latest' ? 'latest' : 'hot'];
      const prefix = `${sort}:`;
      const offset = cursor === null ? 0 : cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : Number.NaN;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > list.length) {
        result = reply({ error: { code: 'CURSOR_INVALID' } }, 422);
      } else {
        result = reply({
          items: list.slice(offset, offset + 20),
          next_cursor: offset + 20 < list.length ? `${prefix}${offset + 20}` : null,
        });
      }
    } else {
      result = reply({ error: { code: 'NOT_FOUND' } }, 404);
    }
    await route.fulfill({ status: result.status ?? 200, json: result.body as Record<string, unknown> });
  });
  return requests;
}

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY));
}

test.describe('一级评论阅读与排序', () => {
  test('评论入口定位评论区，45 条按 20/20/5 追加，结束后不再请求', async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(1);

    await page.getByRole('button', { name: '来源评论 45' }).click();
    await expect(page).toHaveURL(/\/dynamics\/1001$/);
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);
    // 评论入口优先于详情顶部：评论区对齐视口顶部。
    await expect.poll(() => region.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0);
    expect(await scrollY(page)).toBeGreaterThan(100);
    await expect(region.getByRole('radio', { name: '最新' })).toBeVisible();

    await region.getByRole('button', { name: '加载更多评论' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(40);
    await region.getByRole('button', { name: '加载更多评论' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(45);

    expect(requests).toEqual([
      { sort: 'hot', cursor: null },
      { sort: 'hot', cursor: 'hot:20' },
      { sort: 'hot', cursor: 'hot:40' },
    ]);
    await expect(region.getByRole('button', { name: '加载更多评论' })).toHaveCount(0);
    await expect(region.getByText(/加载完毕|已读完/)).toHaveCount(0);

    // 结束后滚动、点击末条都不会再发请求。
    await region.getByRole('listitem').last().scrollIntoViewIfNeeded();
    await region.getByRole('listitem').last().click();
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    expect(requests).toHaveLength(3);
  });

  test('排序切换定位评论区、丢弃旧批次，并按实际超过六行折叠且重置展开', async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: '来源评论 45' }).click();
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);
    const detail = page.getByRole('article');
    const detailHandle = await detail.elementHandle();

    const first = region.getByRole('listitem').first();
    const second = region.getByRole('listitem').nth(1);
    await expect(first.getByRole('button', { name: '展开评论' })).toBeVisible();
    // 恰好六行不出现展开入口。
    await expect(second.getByRole('button', { name: '展开评论' })).toHaveCount(0);
    await first.getByRole('button', { name: '展开评论' }).click();
    await expect(first.getByRole('button', { name: '收起评论' })).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, 1200));
    const before = await scrollY(page);
    expect(before).toBeGreaterThan(0);
    await region.getByRole('radio', { name: '最新' }).click();
    await expect(region.getByRole('radio', { name: '最新' })).toBeChecked();
    await expect.poll(() => region.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0);

    const latestFirst = region.getByRole('listitem').first();
    await expect(latestFirst.getByRole('button', { name: '展开评论' })).toBeVisible();
    await expect(latestFirst.getByRole('button', { name: '收起评论' })).toHaveCount(0);
    await expect(region.getByRole('listitem')).toHaveCount(20);
    // 上方动态不被重建。
    expect(await detailHandle?.evaluate(element => element.isConnected)).toBe(true);

    // 切换后的首批不带旧排序 cursor，也不重复旧批次。
    expect(requests.slice(-1)).toEqual([{ sort: 'latest', cursor: null }]);
  });

  test('历史返回恢复排序、批次与评论锚点，视口变化后仍保持偏移', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const requests = await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: '来源评论 45' }).click();
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await region.getByRole('button', { name: '加载更多评论' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(40);
    await region.getByRole('radio', { name: '最新' }).click();
    await expect(region.getByRole('radio', { name: '最新' })).toBeChecked();
    await region.getByRole('button', { name: '加载更多评论' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(40);

    const anchor = region.getByRole('listitem').nth(25);
    const id = await anchor.getAttribute('data-reading-id');
    await anchor.evaluate(element => {
      window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 40);
    });
    const offset = await anchor.evaluate(element => Math.round(element.getBoundingClientRect().top));
    expect(offset).toBe(40);

    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(1);
    await page.setViewportSize({ width: 390, height: 800 });
    const beforeRestore = requests.length;
    await page.goForward();
    const restored = page.getByRole('region', { name: '评论区' });
    await expect(restored.getByRole('listitem')).toHaveCount(40);
    await expect(restored.getByRole('radio', { name: '最新' })).toBeChecked();
    await expect.poll(() => page.locator(`[data-reading-id="${id}"]`)
      .evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offset);
    // 恢复已读批次不重复请求。
    expect(requests).toHaveLength(beforeRestore);

    await restored.getByRole('button', { name: '加载更多评论' }).click();
    await expect(restored.getByRole('listitem')).toHaveCount(45);
    expect(requests.at(-1)).toEqual({ sort: 'latest', cursor: 'latest:40' });
  });

  test('主动入口优先于旧评论位置', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: '来源评论 45' }).click();
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await page.evaluate(() => window.scrollTo(0, 1600));
    await page.goBack();
    await expect(page.getByRole('article')).toHaveCount(1);

    // 再次点击评论入口是新的访问：重新读最热首批并定位评论区顶部。
    await page.getByRole('button', { name: '来源评论 45' }).click();
    const fresh = page.getByRole('region', { name: '评论区' });
    await expect(fresh.getByRole('listitem')).toHaveCount(20);
    await expect(fresh.getByRole('radio', { name: '最热' })).toBeChecked();
    await expect.poll(() => fresh.evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0);
  });

  test('切换排序时迟到的旧结果不覆盖新选择', async ({ page }) => {
    const requests = await mockApi(page, {
      delay: request => request.sort === 'hot' ? 600 : 50,
    });
    await page.goto('/');
    await page.getByRole('button', { name: '来源评论 45' }).click();
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByText('最热评论加载中…')).toBeVisible();
    await region.getByRole('radio', { name: '最新' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await expect(region.getByRole('radio', { name: '最新' })).toBeChecked();
    const firstLatest = await region.getByRole('listitem').first().textContent();

    // 等旧的最热响应真正到达，页面仍保持最新排序的首批与加载完成状态。
    await page.waitForTimeout(800);
    expect(await region.getByRole('listitem').first().textContent()).toBe(firstLatest);
    await expect(region.getByRole('radio', { name: '最新' })).toBeChecked();
    await expect(region.getByRole('alert')).toHaveCount(0);
    expect(requests.map(request => request.sort ?? request.cursor?.split(':')[0])).toEqual(['hot', 'latest']);
  });

  test('评论区在 360/390/768/1280 宽度下无页面横溢', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: '来源评论 45' }).click();
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
        .toBe(true);
    }
  });
});
