// @projects desktop-chromium-archive
import { expect, test, type Page } from '@playwright/test';

// 宽屏回复跑生产装配 + HTTP 传输替身：仍经过真实 Adapter 的页码/游标映射与页面读取。
// 收起定位、历史恢复与 6 行折叠必须真实浏览器才能验证。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const replier = { id: '7002', nickname: '回复作者', avatar_url: null };
const target = { id: '7003', nickname: '阿蓝', avatar_url: null };
const rootId = '7050';
// 七行正文在宽屏也一定超过六行；六行短行恰好等于折叠阈值。
const replyLongText = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：这是一段足够长的回复正文，用于验证实际超过六行才折叠。`).join('\n');
const replyShortText = Array.from({ length: 6 }, (_value, line) => `第六行边界 ${line + 1}`).join('\n');

function archiveTime(index: number): string {
  const epoch = Date.UTC(2026, 2, 1, 2, 3, 4) + 8 * 3_600_000 + index * 60_000;
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
    like_count: index,
    source_reply_count: 0,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
    ...overrides,
  };
}

// 第 3 条一级评论带 25 条回复（独立 ID，不与前两条冲突），
// 收起定位时下方仍有内容可滚动。
const all = Array.from({ length: 20 }, (_value, index) => comment(index + 1,
  index === 2 ? { id: rootId, source_reply_count: 25 } : {}));

function reply(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(9000 + index),
    dynamic_id: '1001',
    root_id: rootId,
    parent_id: rootId,
    author: replier,
    reply_to: null,
    published_at: archiveTime(index),
    text: `回复 ${index}\n第二行`,
    like_count: index,
    ...overrides,
  };
}

const replyOrder = Array.from({ length: 25 }, (_value, index) => reply(index + 1,
  index === 0 ? { text: replyShortText }
    : index === 1 ? { text: replyLongText }
    : index === 2 ? {
      parent_id: '9002', reply_to: target, text: '回复 @阿蓝: 嵌套目标与来源前缀',
    } : {}));

type ReplyRequest = { page: number | null; limit: number | null; cursor: string | null };

async function mockApi(page: Page) {
  const requests: ReplyRequest[] = [];
  // 同一份归档在两次访问之间变化：用于证明历史恢复是实时重读而不是冻结页。
  let generation = 1;
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body as Record<string, unknown> });
    if (url.pathname === '/api/archive/ups') return respond({ ups: [author] });
    if (url.pathname === '/api/archive/dynamics') return respond({ items: [dynamic()], next_cursor: null });
    if (url.pathname === '/api/archive/dynamics/1001') return respond(dynamic());
    if (/\/api\/archive\/dynamics\/1001\/comments$/.test(url.pathname)) {
      return respond({ items: all, next_cursor: null });
    }
    if (url.pathname === `/api/archive/dynamics/1001/comments/${rootId}/replies`) {
      const page_ = url.searchParams.get('page');
      const limit = url.searchParams.get('limit');
      const cursor = url.searchParams.get('cursor');
      requests.push({ page: page_ === null ? null : Number(page_), limit: limit === null ? null : Number(limit), cursor });
      const items = replyOrder.map(item => ({ ...item, text: `${item.text}` }));
      if (page_ !== null) {
        const offset = (Number(page_) - 1) * 10;
        return respond({
          items: items.slice(offset, offset + 10),
          next_cursor: null,
          count: items.length,
          root: all[2],
          source_reply_count: 25,
          local_reply_count: items.length,
          replies_last_attempt: 'success',
        });
      }
      const offset = cursor === null ? 0 : Number(cursor);
      return respond({
        items: items.slice(offset, offset + 3).map(item => ({ ...item, text: `${item.text}（第${generation}次）` })),
        next_cursor: offset + 3 < items.length ? String(offset + 3) : null,
        source_reply_count: 25,
      });
    }
    return respond({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return { requests, setGeneration: (value: number) => { generation = value; } };
}

function rootComment(page: Page) {
  return page.locator(`[data-reading-id="comment:${rootId}"]`);
}

function replyList(page: Page) {
  return rootComment(page).getByRole('list', { name: '回复列表' });
}

test.describe('宽屏回复预览与实时页码', () => {
  test('预览 3 条、展开按 10/10/5 替换，收起定位根评论并重新首读', async ({ page }) => {
    const api = await mockApi(page);
    await page.goto('/dynamics/1001');
    const region = page.getByRole('region', { name: '评论区' });
    // 只数一级评论；回复列表是每条评论的后代列表。
    await expect(region.locator('[aria-label="一级评论"] > li')).toHaveCount(20);

    // 预览：cursor 首批 3 条，嵌套回复显示目标并剥离来源前缀。
    await expect(replyList(page).locator('> li')).toHaveCount(3);
    expect(api.requests).toEqual([{ page: null, limit: 3, cursor: null }]);
    const nested = replyList(page).locator('> li').nth(2);
    await expect(nested).toContainText('回复 阿蓝:');
    await expect(nested).toContainText('嵌套目标与来源前缀');
    await expect(nested).not.toContainText('回复 @阿蓝');

    await rootComment(page).getByRole('button', { name: '展开回复', exact: true }).click();
    await expect(replyList(page).locator('> li')).toHaveCount(10);
    expect(api.requests.at(-1)).toEqual({ page: 1, limit: 10, cursor: null });
    await expect(region.getByRole('button', { name: '3' })).toBeVisible();

    await region.getByRole('button', { name: '下一页' }).click();
    await expect(replyList(page).locator('> li')).toHaveCount(10);
    await expect(replyList(page).locator('> li').first()).toContainText('回复 11');
    await region.getByRole('button', { name: '下一页' }).click();
    await expect(replyList(page).locator('> li')).toHaveCount(5);
    await expect(replyList(page).locator('> li').last()).toContainText('回复 25');
    expect(api.requests.map(item => item.page)).toEqual([null, 1, 2, 3]);

    // 收起：定位根评论开头，回到 3 条预览。
    await region.getByRole('button', { name: '收起' }).click();
    await expect.poll(() => rootComment(page).evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(0);
    await expect(replyList(page).locator('> li')).toHaveCount(3);
    await expect(rootComment(page).getByRole('navigation', { name: '回复分页' })).toHaveCount(0);

    // 再次展开重新读第 1 页，不恢复第 3 页。
    await rootComment(page).getByRole('button', { name: '展开回复', exact: true }).click();
    await expect(replyList(page).locator('> li')).toHaveCount(10);
    expect(api.requests.at(-1)).toEqual({ page: 1, limit: 10, cursor: null });
    await expect(region.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
  });

  test('详情历史返回恢复展开状态与页码，并按保存页码实时重读', async ({ page }) => {
    const api = await mockApi(page);
    // 宽屏正文入口在独立标签页打开，站内往返只剩窄屏入口：
    // 先用窄屏评论入口建立这次详情访问，再换成宽屏观察回复预览与页码。
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/');
    await page.getByRole('button', { name: '来源评论 45' }).click();
    await expect(page).toHaveURL(/\/dynamics\/1001$/);
    await page.setViewportSize({ width: 1280, height: 900 });
    const region = page.getByRole('region', { name: '评论区' });
    await expect(replyList(page).locator('> li')).toHaveCount(3);
    // 预览里先展开长回复正文，验证文字状态随详情快照恢复。
    await replyList(page).locator('> li').nth(1).getByRole('button', { name: '展开回复正文', exact: true }).click();
    await expect(replyList(page).locator('> li').nth(1)
      .getByRole('button', { name: '收起回复正文', exact: true })).toBeVisible();
    await rootComment(page).getByRole('button', { name: '展开回复', exact: true }).click();
    await expect(replyList(page).locator('> li')).toHaveCount(10);
    await expect(replyList(page).locator('> li').nth(1)
      .getByRole('button', { name: '收起回复正文', exact: true })).toBeVisible();
    await region.getByRole('button', { name: '下一页' }).click();
    await expect(replyList(page).locator('> li').first()).toContainText('回复 11');

    await page.goBack();
    await expect(page.getByRole('main')).toBeVisible();
    // 归档在两次访问之间发生变化：恢复时必须重新读取而不是复用冻结页。
    api.setGeneration(2);
    const before = api.requests.length;
    await page.goForward();

    await expect(page).toHaveURL(/\/dynamics\/1001$/);
    await expect(replyList(page).locator('> li')).toHaveCount(10);
    expect(api.requests.slice(before)).toEqual([{ page: 2, limit: 10, cursor: null }]);
    await expect(rootComment(page).getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
    // 收起状态同样恢复：不回到展开入口，分页器直接可见。
    await expect(rootComment(page).getByRole('button', { name: '展开回复', exact: true })).toHaveCount(0);
    // 回复正文的展开状态也随快照恢复：回到第 1 页仍是展开后的长回复。
    await rootComment(page).getByRole('button', { name: '1' }).click();
    await expect(replyList(page).locator('> li').nth(1)
      .getByRole('button', { name: '收起回复正文', exact: true })).toBeVisible();
  });

  test('回复正文按实际超过 6 行折叠，宽屏各宽度都不出现横向溢出', async ({ page }) => {
    await mockApi(page);
    // 只验宽屏（>640px）：窄屏回复入口由票据 07 交付。
    for (const width of [1280, 1024, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/dynamics/1001');
      await expect(replyList(page).locator('> li')).toHaveCount(3);
      const short = replyList(page).locator('> li').nth(0);
      const long = replyList(page).locator('> li').nth(1);
      // 恰好六行不出现展开入口，七行才折叠。
      await expect(short.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(0);
      const toggle = long.getByRole('button', { name: '展开回复正文', exact: true });
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(long.getByRole('button', { name: '收起回复正文', exact: true })).toBeVisible();
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  });
});
