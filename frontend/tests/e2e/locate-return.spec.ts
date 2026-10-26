// @projects desktop-chromium-archive
import { expect, test, type Locator, type Page } from '@playwright/test';
import { scrollY, sortOption, viewer } from './support';

// 精确入口的返回与恢复（宽屏）跑生产装配 + 归档 HTTP 替身：路由、生产 Adapter、
// 分页与阅读恢复都是真实实现，只有归档响应由替身给出。
// 精确入口不是另一种页面：它是同一次详情阅读的主动定位入口，因此图片预览返回、
// 返回历史记录与切换排序都必须保持已定位的回复页与位置，不再抢回或退回页首。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const replier = { id: '7002', nickname: '回复作者', avatar_url: null };
const dynamicId = '1001';
const totalComments = 45;
// 目标根评论在第 25 位：一级评论定位读取必须把它带进来，不能只读首批。
const rootId = '7025';
const totalReplies = 25;
// 图片所在评论在定位批次中段：预览返回的位置断言因此不是“定位目标顶部”。
const imageCommentId = '7030';
// 目标回复在第 2 页中间：既不是首屏也不是页首。
const targetReplyId = '9014';

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
  const isTarget = id === rootId;
  return {
    id,
    dynamic_id: dynamicId,
    author: commenter,
    published_at: archiveTime(index),
    text: isTarget ? '被定位回复所属的根评论' : `一级评论 ${index}`,
    like_count: totalComments + 1 - index,
    source_reply_count: isTarget ? totalReplies : 0,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
    // 批次中段的一条评论带一张已归档图片：精确入口的图片预览返回不得破坏定位与位置。
    ...(id === imageCommentId
      ? {
        media: [{
          id: 'locate-image-1', owner: { type: 'comment', id },
          status: 'success', public_url: '/locate-image-1.png', width: 800, height: 600,
        }],
      }
      : {}),
  };
}

// 最热顺序与序号一致：目标根评论在第 25 位，普通的 20 条首批不含它。
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
const replyPage = (page: number) => replyOrder.slice((page - 1) * 10, (page - 1) * 10 + 10);

// 1x1 PNG：浏览器只要求可解码，图片内容本身不是本票断言对象。
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

type ArchiveRequest = { kind: 'comment-location' | 'reply-location' | 'replies'; detail: string };

/**
 * 归档替身按后端契约实现定位与分页读取，并让两个定位读取可分别延迟：
 * 用来固定“切换排序后根评论定位批次晚到”的时序。
 */
async function mockArchive(
  page: Page,
  options: { commentLocationDelay?: number; replyLocationDelay?: number } = {},
) {
  const requests: ArchiveRequest[] = [];
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body as Record<string, unknown> });
    if (url.pathname === '/api/archive/ups') return respond({ ups: [author] });
    if (url.pathname === '/api/archive/dynamics') return respond({ items: [dynamic()], next_cursor: null });
    if (url.pathname === `/api/archive/dynamics/${dynamicId}`) return respond(dynamic());

    const commentLocation = url.pathname.match(
      new RegExp(`^/api/archive/dynamics/${dynamicId}/comments/([^/]+)/location$`));
    if (commentLocation) {
      requests.push({ kind: 'comment-location', detail: `${commentLocation[1]!}:${url.searchParams.get('sort')}` });
      if (options.commentLocationDelay) {
        await new Promise(resolve => setTimeout(resolve, options.commentLocationDelay));
      }
      const index = ordered.findIndex(item => item.id === commentLocation[1]);
      if (index < 0) return respond({ error: { code: 'NOT_FOUND' } }, 404);
      return respond({
        items: ordered.slice(index, index + 20),
        next_cursor: index + 20 < ordered.length ? `loc:${index + 20}` : null,
      });
    }

    const replyLocation = url.pathname.match(
      new RegExp(`^/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies/([^/]+)/location$`));
    if (replyLocation) {
      requests.push({ kind: 'reply-location', detail: replyLocation[1]! });
      if (options.replyLocationDelay) {
        await new Promise(resolve => setTimeout(resolve, options.replyLocationDelay));
      }
      const index = replyOrder.findIndex(item => item.id === replyLocation[1]);
      if (index < 0) return respond({ error: { code: 'NOT_FOUND' } }, 404);
      const number = Math.floor(index / 10) + 1;
      return respond({
        items: replyPage(number), next_cursor: null, page: number, count: totalReplies, root: rootComment,
        source_reply_count: totalReplies, local_reply_count: totalReplies, replies_last_attempt: 'success',
      });
    }

    if (url.pathname === `/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies`) {
      const pageParam = url.searchParams.get('page');
      const limit = url.searchParams.get('limit');
      requests.push({ kind: 'replies', detail: `${pageParam}:${limit}` });
      if (pageParam === null) {
        return respond({ items: replyOrder.slice(0, 3), next_cursor: '3', source_reply_count: totalReplies });
      }
      const number = Number(pageParam);
      return respond({
        items: replyPage(number), next_cursor: null, count: totalReplies, root: rootComment,
        source_reply_count: totalReplies, local_reply_count: totalReplies, replies_last_attempt: 'success',
      });
    }

    if (url.pathname === `/api/archive/dynamics/${dynamicId}/comments`) {
      const cursor = url.searchParams.get('cursor');
      const offset = cursor === null ? 0 : Number(cursor.startsWith('loc:') ? cursor.slice(4) : cursor);
      return respond({
        items: ordered.slice(offset, offset + 20),
        next_cursor: offset + 20 < ordered.length ? `loc:${offset + 20}` : null,
      });
    }
    return respond({ error: { code: 'NOT_FOUND' } }, 404);
  });
  await page.route('**/locate-image-1.png', async route => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: pixel });
  });
  return requests;
}

const commentLocatePath = `/dynamics/${dynamicId}/comments/${rootId}/locate`;
const replyLocatePath = `/dynamics/${dynamicId}/comments/${rootId}/replies/${targetReplyId}/locate`;

function located(page: Page) {
  return page.locator('[data-located="true"]');
}

/** 只数一级评论：回复区里的列表项属于同一条根的回复，不是独立一级评论。 */
function commentItems(page: Page): Locator {
  return page.locator('[data-reading-id^="comment:"]');
}

async function viewportTop(page: Page, readingId: string): Promise<number> {
  return page.locator(`[data-reading-id="${readingId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top));
}

test.describe('精确入口的返回与恢复（宽屏）', () => {
  test('精确入口的图片预览打开再返回：已读批次、高亮与位置都不退化', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(commentLocatePath);
    await expect(commentItems(page)).toHaveCount(20);
    const target = page.locator(`[data-reading-id="comment:${rootId}"]`);
    await expect(target).toHaveAttribute('data-located', 'true');
    expect(requests).toEqual([
      { kind: 'comment-location', detail: `${rootId}:hot` },
      // 目标根评论的回复区按常规首屏读 3 条预览（与普通详情一致）。
      { kind: 'replies', detail: 'null:3' },
    ]);

    // 定位后继续读到批次中段，再从那里打开图片预览。
    const trigger = page.locator(`#preview-trigger-comment-${imageCommentId}-0`);
    await trigger.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    const before = await scrollY(page);
    expect(before).toBeGreaterThan(100);

    await trigger.click();
    await expect(viewer(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toBeHidden();

    // 关闭预览回到同一次精确访问：同一批 20 条、唯一高亮与同一位置都在，也不重新定位。
    await expect(page).toHaveURL(new RegExp(`/comments/${rootId}/locate$`));
    await expect(commentItems(page)).toHaveCount(20);
    await expect(located(page)).toHaveCount(1);
    await expect(target).toHaveAttribute('data-located', 'true');
    expect(requests.filter(request => request.kind === 'comment-location')).toHaveLength(1);
    expect(requests.filter(request => request.kind !== 'comment-location'))
      .toEqual([{ kind: 'replies', detail: 'null:3' }]);
    await expect.poll(() => scrollY(page)).toBe(before);
  });

  test('切换排序时根评论定位批次晚到：目标回复仍留在视口，页码不回到第 1 页', async ({ page }) => {
    // 受控延迟：根评论定位批次晚到 600ms，目标回复所在页立即返回。
    const requests = await mockArchive(page, { commentLocationDelay: 600 });
    await page.goto(replyLocatePath);
    const target = page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`);
    await expect(target).toHaveAttribute('data-located', 'true');
    await expect.poll(() => viewportTop(page, `reply:${rootId}:${targetReplyId}`)).toBeLessThan(24);

    const region = page.getByRole('region', { name: '评论区' });
    await sortOption(region, '最新').click();
    await expect(region.getByRole('radio', { name: '最新' })).toBeChecked();

    // 等晚到的根评论定位批次真正落地：目标回复仍在视口顶部，没有被根评论定位抢走。
    await expect(target).toHaveAttribute('data-located', 'true');
    await page.waitForTimeout(1200);
    await expect.poll(() => viewportTop(page, `reply:${rootId}:${targetReplyId}`)).toBeLessThan(24);
    await expect(target).toHaveAttribute('data-located', 'true');
    await expect(located(page)).toHaveCount(1);
    await expect(page.locator(`[data-reading-id="comment:${rootId}"]`).getByRole('button', { name: '2' }))
      .toHaveAttribute('aria-current', 'page');
    expect(requests.filter(request => request.kind === 'comment-location').map(request => request.detail))
      .toEqual([`${rootId}:hot`, `${rootId}:latest`]);
    expect(requests.filter(request => request.kind === 'replies')).toEqual([]);
  });

  test('切换排序时目标回复页晚到：根评论定位先落地，最终仍以目标回复为准', async ({ page }) => {
    const requests = await mockArchive(page, { replyLocationDelay: 600 });
    await page.goto(replyLocatePath);
    const target = page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`);
    await expect(target).toHaveAttribute('data-located', 'true');

    const region = page.getByRole('region', { name: '评论区' });
    await sortOption(region, '最新').click();
    await page.waitForTimeout(1400);

    await expect.poll(() => viewportTop(page, `reply:${rootId}:${targetReplyId}`)).toBeLessThan(24);
    await expect(target).toHaveAttribute('data-located', 'true');
    await expect(located(page)).toHaveCount(1);
    expect(requests.filter(request => request.kind === 'reply-location')).toHaveLength(2);
  });
});
