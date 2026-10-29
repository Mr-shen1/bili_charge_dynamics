// @projects mobile-chromium-archive
import { expect, test, type Page } from '@playwright/test';
import { scrollY } from './support';

// 精确根入口的返回与恢复（窄屏）跑生产装配 + 归档 HTTP 替身：
// 640px 分支把一级评论定位放在详情页里，进入独立楼中楼必须记下这次精确访问，
// 返回后恢复它自己的已读批次、定位与位置；刷新仍是新访问，按 URL 主动定位。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const replier = { id: '7002', nickname: '回复作者', avatar_url: null };
const dynamicId = '1001';
const totalComments = 45;
// 目标根评论在第 25 位：定位读取只带它这一批，普通首批 20 条不含它。
const rootId = '7025';
const totalReplies = 25;

function archiveTime(index: number): string {
  const epoch = Date.UTC(2026, 2, 1, 2, 3, 4) + 8 * 3_600_000 + index * 60_000;
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
    source_comment_count: totalComments,
    local_comment_count: totalComments,
    media_sources: [],
    comment_locator: null,
    observed_version: null,
    synced_version: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    root_comments_last_attempt: 'success',
  };
}

function comment(index: number) {
  const id = String(7000 + index);
  return {
    id,
    dynamic_id: dynamicId,
    author: commenter,
    published_at: archiveTime(index),
    text: id === rootId ? '被精确定位的根评论' : `一级评论 ${index}`,
    like_count: totalComments + 1 - index,
    source_reply_count: id === rootId ? totalReplies : 0,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
  };
}

const ordered = Array.from({ length: totalComments }, (_value, index) => comment(index + 1));
const rootComment = ordered.find(item => item.id === rootId)!;

function reply(index: number) {
  return {
    id: String(9000 + index),
    dynamic_id: dynamicId,
    root_id: rootId,
    parent_id: rootId,
    author: replier,
    reply_to: null,
    published_at: archiveTime(index),
    text: `回复 ${index}`,
    like_count: index,
  };
}

const replyOrder = Array.from({ length: totalReplies }, (_value, index) => reply(index + 1));

type ArchiveRequest = { kind: 'comment-location' | 'comments' | 'replies'; detail: string };

/**
 * 归档替身：定位返回以目标开头的一批并提供续读游标，comments 的 cursor 从该位置继续，
 * 因此“已读批”在返回后是否还在可以按条数与续读请求直接核对。
 */
async function mockArchive(page: Page) {
  const requests: ArchiveRequest[] = [];
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body as Record<string, unknown> });
    if (url.pathname === '/api/archive/ups') return respond({ ups: [author] });
    if (url.pathname === '/api/archive/dynamics') return respond({ items: [dynamic()], next_cursor: null });
    if (url.pathname === `/api/archive/dynamics/${dynamicId}`) return respond(dynamic());

    const location = url.pathname.match(
      new RegExp(`^/api/archive/dynamics/${dynamicId}/comments/([^/]+)/location$`));
    if (location) {
      requests.push({ kind: 'comment-location', detail: `${location[1]!}:${url.searchParams.get('sort')}` });
      const index = ordered.findIndex(item => item.id === location[1]);
      if (index < 0) return respond({ error: { code: 'NOT_FOUND' } }, 404);
      return respond({
        items: ordered.slice(index, index + 20),
        next_cursor: index + 20 < ordered.length ? `loc:${index + 20}` : null,
      });
    }

    if (url.pathname === `/api/archive/dynamics/${dynamicId}/comments`) {
      const cursor = url.searchParams.get('cursor');
      requests.push({ kind: 'comments', detail: `${cursor}:${url.searchParams.get('sort')}` });
      const offset = cursor === null ? 0 : Number(cursor.startsWith('loc:') ? cursor.slice(4) : Number.NaN);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > ordered.length) {
        return respond({ error: { code: 'CURSOR_INVALID' } }, 422);
      }
      return respond({
        items: ordered.slice(offset, offset + 20),
        next_cursor: offset + 20 < ordered.length ? `loc:${offset + 20}` : null,
      });
    }

    if (url.pathname === `/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies`) {
      const pageParam = url.searchParams.get('page');
      requests.push({ kind: 'replies', detail: `${pageParam}:${url.searchParams.get('limit')}` });
      const number = pageParam === null ? 1 : Number(pageParam);
      const offset = (number - 1) * 10;
      return respond({
        items: replyOrder.slice(offset, offset + 10),
        next_cursor: null,
        count: totalReplies,
        root: rootComment,
        source_reply_count: totalReplies,
        local_reply_count: totalReplies,
        replies_last_attempt: 'success',
      });
    }
    return respond({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return requests;
}

const locatePath = `/dynamics/${dynamicId}/comments/${rootId}/locate`;

function located(page: Page) {
  return page.locator('[data-located="true"]');
}

function locatedItem(page: Page) {
  return page.locator(`[data-reading-id="comment:${rootId}"]`);
}

async function viewportTop(page: Page, readingId: string): Promise<number> {
  return page.locator(`[data-reading-id="${readingId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top));
}

test.describe('精确根入口的返回与恢复（窄屏）', () => {
  test('定位后继续追加并滚动，进入独立楼中楼再返回：批次、高亮与位置都在且不重新定位', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(locatePath);
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(20);
    await expect(locatedItem(page)).toHaveAttribute('data-located', 'true');
    await expect.poll(() => viewportTop(page, `comment:${rootId}`)).toBeLessThan(24);
    expect(requests).toEqual([{ kind: 'comment-location', detail: `${rootId}:latest` }]);

    // 定位后继续阅读：追加最后一批，并把视口移到批次中段。
    await region.getByRole('button', { name: '加载更多评论' }).click();
    await expect(region.getByRole('listitem')).toHaveCount(21);
    expect(requests.at(-1)).toEqual({ kind: 'comments', detail: 'loc:44:latest' });
    await page.evaluate(() => window.scrollTo(0, 320));
    const before = await scrollY(page);
    expect(before).toBe(320);

    // 进入独立楼中楼：这次精确访问是楼中楼的来源，返回必须回到它而不是普通详情顶部。
    await region.getByRole('button', { name: `共${totalReplies}条回复` }).click();
    await expect(page).toHaveURL(new RegExp(`/comments/${rootId}$`));
    await expect(page.getByRole('list', { name: '相关回复' }).locator('> li')).toHaveCount(10);

    await page.getByRole('button', { name: '评论详情，返回动态详情' }).click();
    await expect(page).toHaveURL(new RegExp(`/comments/${rootId}/locate$`));

    // 同一次访问恢复：21 条已读批次、唯一高亮与同一位置；不再请求定位端点。
    const restored = page.getByRole('region', { name: '评论区' });
    await expect(restored.getByRole('listitem')).toHaveCount(21);
    await expect(located(page)).toHaveCount(1);
    await expect(locatedItem(page)).toHaveAttribute('data-located', 'true');
    expect(requests.filter(request => request.kind === 'comment-location')).toHaveLength(1);
    await expect.poll(() => scrollY(page)).toBe(before);
  });

  test('刷新精确根入口仍是新访问：按 URL 主动定位，不复用旧批次与位置', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(locatePath);
    await expect(locatedItem(page)).toHaveAttribute('data-located', 'true');
    await page.evaluate(() => window.scrollTo(0, 320));
    expect(await scrollY(page)).toBe(320);

    await page.reload();
    await expect(locatedItem(page)).toHaveAttribute('data-located', 'true');
    // 刷新后重新按 URL 定位：定位批次仍然只有 20 条，落点回到目标而不是上次的滚动位置。
    await expect(page.getByRole('region', { name: '评论区' }).getByRole('listitem')).toHaveCount(20);
    expect(requests.filter(request => request.kind === 'comment-location')).toHaveLength(2);
    expect(requests.filter(request => request.kind === 'comments')).toEqual([]);
    await expect.poll(() => viewportTop(page, `comment:${rootId}`)).toBeLessThan(24);
    expect(await scrollY(page)).toBeGreaterThan(0);
  });
});
