// @projects desktop-chromium-archive, mobile-chromium-archive
import { expect, test, type Page } from '@playwright/test';
import { commentSort, scrollY, switchCommentSort } from './support';

// 一级评论精确入口跑生产装配 + 归档 HTTP 替身：路由、生产 Adapter、DTO 映射、
// 分页与阅读恢复都是真实实现，只有归档响应由替身给出。定位、展开与滚动必须真实浏览器。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const dynamicId = '1001';
// 45 条一级评论：最热与最新都按 7001…7045 排序，定位窗口因此可逐项核对。
const total = 45;
const longText = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：这是一段足够长的评论正文，用于验证定位后默认展开。`).join('\n');

function archiveTime(index: number): string {
  const epoch = Date.UTC(2026, 2, 1, 2, 3, 4) - index * 3_600_000 + 8 * 3_600_000;
  return `${new Date(epoch).toISOString().slice(0, 19)}+08:00`;
}

function dynamic() {
  return {
    id: dynamicId,
    author,
    published_at: '2026-03-01T10:03:04+08:00',
    edit_status: 'unknown',
    text: '详情正文',
    content_state: 'success',
    last_attempt: 'success',
    source_comment_count: total,
    local_comment_count: total,
    media_sources: [],
    comment_locator: null,
    observed_version: null,
    synced_version: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    root_comments_last_attempt: 'success',
  };
}

function comment(index: number) {
  return {
    id: String(7000 + index),
    dynamic_id: dynamicId,
    author: commenter,
    published_at: archiveTime(index),
    text: index === 25 ? longText : `一级评论 ${index}`,
    // 点赞随序号递减：最热排序与序号一致，定位窗口可按序号核对。
    like_count: total + 1 - index,
    source_reply_count: 0,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
  };
}

const ordered = Array.from({ length: total }, (_value, index) => comment(index + 1));
const target = ordered[24]!;
const ids = ordered.map(item => item.id);

type ArchiveRequest = { kind: 'location' | 'comments'; sort: string | null; cursor: string | null };

/**
 * 归档替身：comments 与 location 两个端点，行为按后端契约实现——
 * location 返回以目标开头的一批并提供续读游标，comments 的 cursor 从该位置继续。
 */
async function mockArchive(
  page: Page,
  options: { locationDelay?: (rootId: string) => number; locationFailures?: number } = {},
) {
  const requests: ArchiveRequest[] = [];
  let failures = 0;
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const reply = async (body: unknown, status = 200) => {
      await route.fulfill({ status, json: body as Record<string, unknown> });
    };
    if (url.pathname === '/api/archive/ups') return reply({ ups: [author] });
    if (url.pathname === '/api/archive/dynamics') return reply({ items: [dynamic()], next_cursor: null });
    if (url.pathname === `/api/archive/dynamics/${dynamicId}`) return reply(dynamic());
    const location = url.pathname.match(new RegExp(`^/api/archive/dynamics/${dynamicId}/comments/([^/]+)/location$`));
    if (location) {
      const sort = url.searchParams.get('sort');
      requests.push({ kind: 'location', sort, cursor: null });
      const delay = options.locationDelay?.(location[1]!) ?? 0;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      if (failures < (options.locationFailures ?? 0)) {
        failures += 1;
        return reply({ error: { code: 'STORAGE_UNAVAILABLE' } }, 503);
      }
      const index = ids.indexOf(location[1]!);
      if (index < 0) return reply({ error: { code: 'NOT_FOUND' } }, 404);
      return reply({
        items: ordered.slice(index, index + 20),
        next_cursor: index + 20 < ordered.length ? `loc:${index + 20}` : null,
        prev_cursor: index > 0 ? `pre:${index}` : null,
        earlier_count: index,
      });
    }
    if (url.pathname === `/api/archive/dynamics/${dynamicId}/comments`) {
      const cursor = url.searchParams.get('cursor');
      requests.push({ kind: 'comments', sort: url.searchParams.get('sort'), cursor });
      // 向前游标以窗口终点为坐标：返回它之前的一批，不与已读窗口重叠。
      if (cursor !== null && cursor.startsWith('pre:')) {
        const end = Number(cursor.slice(4));
        if (!Number.isSafeInteger(end) || end < 1 || end > ordered.length) {
          return reply({ error: { code: 'CURSOR_INVALID' } }, 422);
        }
        const start = Math.max(0, end - 20);
        return reply({
          items: ordered.slice(start, end),
          next_cursor: null,
          prev_cursor: start > 0 ? `pre:${start}` : null,
          earlier_count: start,
        });
      }
      const offset = cursor === null ? 0 : Number(cursor.startsWith('loc:') ? cursor.slice(4) : Number.NaN);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > ordered.length) {
        return reply({ error: { code: 'CURSOR_INVALID' } }, 422);
      }
      return reply({
        items: ordered.slice(offset, offset + 20),
        next_cursor: offset + 20 < ordered.length ? `loc:${offset + 20}` : null,
        prev_cursor: offset > 0 ? `pre:${offset}` : null,
        earlier_count: offset,
      });
    }
    return reply({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return requests;
}

const locatePath = (rootId: string) => `/dynamics/${dynamicId}/comments/${rootId}/locate`;

function located(page: Page) {
  return page.locator('[data-located="true"]');
}

async function viewportTop(page: Page, rootId: string): Promise<number> {
  return page.locator(`[data-reading-id="comment:${rootId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top));
}

// 同一套用例在桌面与 Pixel 7 两个项目各跑一遍：宽窄屏都从同一链接直达。
test.describe('一级评论精确链接', () => {
  test('直开定位链接：自动取含目标的批次、高亮并展开目标，续读从定位窗口继续', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(locatePath(target.id));
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);

    // 只请求定位批次，没有先读首批，也没有把全部评论渲染出来。
    // 新访问默认按时间：定位请求也显式带 latest，不显示“按时间”却用 hot 的位置结果。
    expect(requests).toEqual([{ kind: 'location', sort: 'latest', cursor: null }]);
    const item = page.locator(`[data-reading-id="comment:${target.id}"]`);
    await expect(item).toHaveAttribute('data-located', 'true');
    await expect(located(page)).toHaveCount(1);
    await expect(item).toHaveAttribute('aria-current', 'true');
    await expect(commentSort(region, 'latest')).toBeVisible();

    // 定位落在目标评论本身：目标贴近视口顶部，而不是页首。
    await expect.poll(() => viewportTop(page, target.id)).toBeLessThan(24);
    expect(await scrollY(page)).toBeGreaterThan(100);
    // 折叠的目标正文已被展开，可直接阅读。
    await expect(item.getByText(longText.split('\n')[0]!)).toBeVisible();
    await expect(item.getByRole('button', { name: '收起评论' })).toBeVisible();

    // 续读沿用定位窗口的游标：只剩最后一条，结束后不再请求。
    await region.getByRole('button', { name: '加载更多评论' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(21);
    await expect(region.getByRole('button', { name: '加载更多评论' })).toHaveCount(0);
    expect(requests.at(-1)).toEqual({ kind: 'comments', sort: 'latest', cursor: 'loc:44' });
    expect(requests).toHaveLength(2);

    // 刷新后同样从链接定位，不依赖旧会话或已加载的 DOM。
    await page.reload();
    const reloaded = page.getByRole('region', { name: '评论区' });
    await expect(reloaded.getByRole('listitem')).toHaveCount(20);
    await expect(page.locator(`[data-reading-id="comment:${target.id}"]`)).toHaveAttribute('data-located', 'true');
    await expect.poll(() => viewportTop(page, target.id)).toBeLessThan(24);
    // 定位完成后不再抢占滚动：用户滚动后位置保持，不产生新请求。
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(300);
    const after = await scrollY(page);
    await page.waitForTimeout(300);
    expect(await scrollY(page)).toBe(after);
    expect(requests.filter(request => request.kind === 'location')).toHaveLength(2);
  });

  test('普通详情入口不受影响：不带定位时不请求定位端点也不高亮', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(`/dynamics/${dynamicId}`);
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await expect(located(page)).toHaveCount(0);
    expect(requests).toEqual([{ kind: 'comments', sort: 'latest', cursor: null }]);
    // 首批仍是原排序的前 20 条。
    await expect(region.getByRole('listitem').first()).toHaveAttribute('data-reading-id', `comment:${ids[0]}`);
  });

  test('目标不存在时给出明确提示并可返回对应动态，不把页首当定位结果', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(locatePath('9999'));
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('status').filter({ hasText: '不存在或未归档' })).toBeVisible();
    await expect(region.getByRole('listitem')).toHaveCount(0);
    await expect(located(page)).toHaveCount(0);
    expect(requests.every(request => request.kind === 'location')).toBe(true);

    await region.getByRole('button', { name: '返回动态' }).click();
    await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
    await expect(page.getByRole('region', { name: '评论区' }).getByRole('listitem')).toHaveCount(20);
  });

  test('临时加载失败可局部重试，重试成功后才定位高亮', async ({ page }) => {
    const requests = await mockArchive(page, { locationFailures: 1 });
    await page.goto(locatePath(target.id));
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('alert')).toContainText('读取失败');
    await expect(located(page)).toHaveCount(0);

    await region.getByRole('button', { name: '重试' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await expect(page.locator(`[data-reading-id="comment:${target.id}"]`)).toHaveAttribute('data-located', 'true');
    // 两次定位尝试：先失败、后成功；失败不是“不存在”，也没有落到列表顶部。
    expect(requests.filter(request => request.kind === 'location')).toHaveLength(2);
  });

  test('定位期间切换排序：迟到的旧排序结果不覆盖，新排序仍以同一目标定位', async ({ page }) => {
    const requests = await mockArchive(page, { locationDelay: () => 600 });
    await page.goto(locatePath(target.id));
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByText('最新评论加载中…')).toBeVisible();
    await switchCommentSort(region);
    await expect(commentSort(region, 'hot')).toBeVisible();
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await expect(page.locator(`[data-reading-id="comment:${target.id}"]`)).toHaveAttribute('data-located', 'true');

    // 等按时间的迟到响应真正到达：页面仍是按热度排序的定位批次，不出现失败提示。
    await page.waitForTimeout(900);
    await expect(commentSort(region, 'hot')).toBeVisible();
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await expect(located(page)).toHaveCount(1);
    await expect(region.getByRole('alert')).toHaveCount(0);
    expect(requests.filter(request => request.kind === 'location').map(request => request.sort))
      .toEqual(['latest', 'hot']);
  });

  test('宽窄屏都不产生横向溢出，定位后目标仍可读', async ({ page }) => {
    await mockArchive(page);
    await page.goto(locatePath(target.id));
    await expect(page.getByRole('region', { name: '评论区' }).getByRole('listitem')).toHaveCount(20);
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
        .toBe(true);
      await expect(page.locator(`[data-reading-id="comment:${target.id}"]`)).toBeVisible();
    }
  });

  test('定位后可以向前读目标之前的评论：提示更早条数、插入后视口不跳动', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(locatePath(target.id));
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await expect(region.getByText('以上还有 24 条更早评论')).toBeVisible();

    // 模拟用户滚到提示行点击：以点击那一刻的视口位置为基准，插入后必须保持不动。
    const earlierButton = region.getByRole('button', { name: '加载更早评论' });
    await earlierButton.scrollIntoViewIfNeeded();
    const beforeTop = await viewportTop(page, target.id);
    await earlierButton.click();
    await expect(region.getByRole('listitem')).toHaveCount(40);
    const afterTop = await viewportTop(page, target.id);
    expect(Math.abs(afterTop - beforeTop)).toBeLessThanOrEqual(4);
    await expect(region.getByText('以上还有 4 条更早评论')).toBeVisible();
    // 更早的一批插在最前面，目标仍在原来的阅读位置（不以“跳回页首”代替定位）。
    await expect(page.locator(`[data-reading-id="comment:${target.id}"]`)).toHaveAttribute('data-located', 'true');

    // 再向前一次就到底：提示消失，目标之前的 24 条全部可读。
    await region.getByRole('button', { name: '加载更早评论' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(44);
    await expect(region.getByText(/以上还有/)).toHaveCount(0);
    await expect(region.getByRole('button', { name: '加载更早评论' })).toHaveCount(0);

    // 后向游标仍是定位窗口给的：继续“加载更多评论”读到最后一条。
    await region.getByRole('button', { name: '加载更多评论' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(45);
    expect(requests.map(request => request.cursor)).toEqual([null, 'pre:24', 'pre:4', 'loc:44']);
  });
});
