// @projects desktop-chromium-archive
import { expect, test, type Page } from '@playwright/test';
import { scrollY } from './support';

// 楼中楼回复精确入口（宽屏）跑生产装配 + HTTP 传输替身：路由、生产 Adapter、一级评论与
// 回复页码读取、展开与阅读恢复都是真实实现，只有归档响应由替身给出。
// 目标在后续页、折叠正文展开、收起与滚动时间线必须真实浏览器才能验证。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const replier = { id: '7002', nickname: '回复作者', avatar_url: null };
const dynamicId = '1001';
const totalComments = 45;
// 目标根评论在第 25 位：一级评论定位读取必须把它带进来，不能只读首批。
const rootId = '7025';
// 七行正文在宽屏一定超过六行折叠阈值：定位时必须已展开才能直接阅读。
const longReplyText = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：这是一段足够长的回复正文，用于验证定位后默认展开。`).join('\n');
const totalReplies = 25;
// 目标在第 2 页中间：既不是首屏也不是页首。
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
  return {
    id,
    dynamic_id: dynamicId,
    author: commenter,
    published_at: archiveTime(index),
    text: id === rootId ? '被定位回复所属的根评论' : `一级评论 ${index}`,
    like_count: totalComments + 1 - index,
    source_reply_count: id === rootId ? totalReplies : 0,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
  };
}

// 最热顺序与序号一致：目标根评论在第 25 位，首次的 20 条不含它。
const ordered = Array.from({ length: totalComments }, (_value, index) => comment(index + 1));
const rootComment = ordered.find(item => item.id === rootId)!;

function reply(index: number) {
  return {
    id: String(9000 + index),
    dynamic_id: dynamicId,
    root_id: rootId,
    parent_id: rootId,
    author: index === 1 ? author : replier,
    reply_to: null,
    published_at: archiveTime(index),
    // 目标回复（第 14 条，落在第 2 页）用七行正文：定位时必须已展开。
    text: index === 14 ? longReplyText : `回复 ${index}\n第二行`,
    like_count: index,
  };
}

const replyOrder = Array.from({ length: totalReplies }, (_value, index) => reply(index + 1));
const replyPage = (page: number) => replyOrder.slice((page - 1) * 10, (page - 1) * 10 + 10);

type ArchiveRequest =
  | { kind: 'comment-location'; rootId: string }
  | { kind: 'reply-location'; replyId: string }
  | { kind: 'replies'; page: number | null; limit: number | null; cursor: string | null };

/**
 * 归档替身按后端契约实现三个读取：一级评论定位（02）、回复页码、回复定位（03）。
 * 回复定位返回目标所在页并带页码；游标模式仍按 3 条预览返回。
 */
async function mockArchive(
  page: Page,
  options: {
    replyLocationFailures?: number;
    replyLocationDelay?: number;
    missingReply?: boolean;
  } = {},
) {
  const requests: ArchiveRequest[] = [];
  let failures = 0;
  let delays = 0;
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const reply = async (body: unknown, status = 200) => {
      await route.fulfill({ status, json: body as Record<string, unknown> });
    };
    if (url.pathname === '/api/archive/ups') return reply({ ups: [author] });
    if (url.pathname === '/api/archive/dynamics') return reply({ items: [dynamic()], next_cursor: null });
    if (url.pathname === `/api/archive/dynamics/${dynamicId}`) return reply(dynamic());

    const commentLocation = url.pathname.match(new RegExp(`^/api/archive/dynamics/${dynamicId}/comments/([^/]+)/location$`));
    if (commentLocation) {
      const index = ordered.findIndex(item => item.id === commentLocation[1]);
      requests.push({ kind: 'comment-location', rootId: commentLocation[1]! });
      if (index < 0) return reply({ error: { code: 'NOT_FOUND' } }, 404);
      return reply({
        items: ordered.slice(index, index + 20),
        next_cursor: index + 20 < ordered.length ? `loc:${index + 20}` : null,
      });
    }

    const replyLocation = url.pathname.match(
      new RegExp(`^/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies/([^/]+)/location$`));
    if (replyLocation) {
      requests.push({ kind: 'reply-location', replyId: replyLocation[1]! });
      if (options.replyLocationDelay) {
        delays += 1;
        await new Promise(resolve => setTimeout(resolve, options.replyLocationDelay));
      }
      if (failures < (options.replyLocationFailures ?? 0)) {
        failures += 1;
        return reply({ error: { code: 'STORAGE_UNAVAILABLE' } }, 503);
      }
      const index = replyOrder.findIndex(item => item.id === replyLocation[1]);
      if (index < 0 || options.missingReply) return reply({ error: { code: 'NOT_FOUND' } }, 404);
      const number = Math.floor(index / 10) + 1;
      return reply({
        items: replyPage(number),
        next_cursor: null,
        page: number,
        count: totalReplies,
        root: rootComment,
        source_reply_count: totalReplies,
        local_reply_count: totalReplies,
        replies_last_attempt: 'success',
      });
    }

    if (url.pathname === `/api/archive/dynamics/${dynamicId}/comments`) {
      return reply({ items: ordered.slice(0, 20), next_cursor: 'first-page-20' });
    }

    if (url.pathname === `/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies`) {
      const pageParam = url.searchParams.get('page');
      const limit = url.searchParams.get('limit');
      const cursor = url.searchParams.get('cursor');
      requests.push({
        kind: 'replies',
        page: pageParam === null ? null : Number(pageParam),
        limit: limit === null ? null : Number(limit),
        cursor,
      });
      if (pageParam === null) {
        // 普通预览仍是 3 条 cursor 首批。
        return reply({ items: replyOrder.slice(0, 3), next_cursor: cursor === null ? '3' : null,
          source_reply_count: totalReplies });
      }
      const number = Number(pageParam);
      return reply({
        items: replyPage(number),
        next_cursor: null,
        count: totalReplies,
        root: rootComment,
        source_reply_count: totalReplies,
        local_reply_count: totalReplies,
        replies_last_attempt: 'success',
      });
    }
    return reply({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return { requests, delays: () => delays };
}

const locatePath = (replyId = targetReplyId) => `/dynamics/${dynamicId}/comments/${rootId}/replies/${replyId}/locate`;

function rootItem(page: Page) {
  return page.locator(`[data-reading-id="comment:${rootId}"]`);
}

function replyList(page: Page) {
  return rootItem(page).getByRole('list', { name: '回复列表' });
}

function located(page: Page) {
  return page.locator('[data-located="true"]');
}

async function viewportTop(page: Page, replyId: string): Promise<number> {
  return page.locator(`[data-reading-id="reply:${rootId}:${replyId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top));
}

test.describe('宽屏楼中楼回复精确链接', () => {
  test('直开定位链接：只读所属根与目标所在页，展开高亮并停在第 2 页', async ({ page }) => {
    const api = await mockArchive(page);
    await page.goto(locatePath());

    const target = page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`);
    await expect(target).toBeVisible();
    // 只有两次只读定位：先取含所属根评论的批次，再取目标所在页；不先读首批或第 1 页。
    expect(api.requests).toEqual([
      { kind: 'comment-location', rootId },
      { kind: 'reply-location', replyId: targetReplyId },
    ]);
    // 页内替换：本页 10 条，不是一次渲染全部 25 条。
    await expect(replyList(page).locator('> li')).toHaveCount(10);
    // 只有目标一条被标记，且定位落在目标回复本身。
    await expect(located(page)).toHaveCount(1);
    await expect(target).toHaveAttribute('data-located', 'true');
    await expect(target).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => viewportTop(page, targetReplyId)).toBeLessThan(24);
    // 折叠的正文已展开：可直接阅读，不需要再点一次。
    await expect(target.getByText('第七行边界 7')).toBeVisible();
    await expect(target.getByRole('button', { name: '收起回复正文' })).toBeVisible();
    // 分页停在第 2 页，不重置为第 1 页。
    await expect(rootItem(page).getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
    await expect(rootItem(page).getByText('共3页')).toBeVisible();

    // 定位后的翻页仍是原页内替换，不累计也不额外定位。
    await rootItem(page).getByRole('button', { name: '下一页' }).click();
    await expect(replyList(page).locator('> li')).toHaveCount(5);
    expect(api.requests.at(-1)).toEqual({ kind: 'replies', page: 3, limit: 10, cursor: null });
    await expect(located(page)).toHaveCount(0);

    // 收起回到常规 3 条预览首屏，并把所属根评论定位到开头。
    await rootItem(page).getByRole('button', { name: '收起' }).click();
    await expect(replyList(page).locator('> li')).toHaveCount(3);
    expect(api.requests.at(-1)).toEqual({ kind: 'replies', page: null, limit: 3, cursor: null });
    await expect.poll(() => rootItem(page).evaluate(element => Math.round(element.getBoundingClientRect().top)))
      .toBe(0);
  });

  test('刷新后仍从链接定位，完成后不再抢占滚动', async ({ page }) => {
    const api = await mockArchive(page);
    await page.goto(locatePath());
    await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`))
      .toHaveAttribute('data-located', 'true');

    await page.reload();
    const target = page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`);
    await expect(target).toHaveAttribute('data-located', 'true');
    await expect.poll(() => viewportTop(page, targetReplyId)).toBeLessThan(24);
    expect(api.requests.filter(request => request.kind !== 'replies')).toEqual([
      { kind: 'comment-location', rootId },
      { kind: 'reply-location', replyId: targetReplyId },
      { kind: 'comment-location', rootId },
      { kind: 'reply-location', replyId: targetReplyId },
    ]);

    // 用户滚动后位置保持，迟到的定位不再抢回。
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(300);
    const after = await scrollY(page);
    await page.waitForTimeout(300);
    expect(await scrollY(page)).toBe(after);
  });

  test('目标不存在时明确提示并可返回对应动态，不把楼层顶部当成功', async ({ page }) => {
    const api = await mockArchive(page);
    await page.goto(locatePath('9999'));
    const replyRegion = rootItem(page).getByRole('region', { name: '回复区' });
    await expect(replyRegion.getByRole('status').filter({ hasText: '不存在或未保存' })).toBeVisible();
    // 所属根评论仍作为上下文存在，但没有高亮、没有回复列表。
    await expect(rootItem(page)).toBeVisible();
    await expect(replyList(page)).toHaveCount(0);
    await expect(located(page)).toHaveCount(0);

    await replyRegion.getByRole('button', { name: '返回动态' }).click();
    await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
    // 返回后是普通详情：首批 20 条一级评论，不请求任何定位端点。
    await expect(page.getByRole('region', { name: '评论区' }).locator('[aria-label="一级评论"] > li'))
      .toHaveCount(20);
    expect(api.requests.filter(request => request.kind === 'replies')).toEqual([]);
  });

  test('临时失败只在回复区重试，重试成功后才展开并高亮目标', async ({ page }) => {
    const api = await mockArchive(page, { replyLocationFailures: 1 });
    await page.goto(locatePath());
    const replyRegion = rootItem(page).getByRole('region', { name: '回复区' });
    await expect(replyRegion.getByRole('alert')).toContainText('读取失败');
    await expect(located(page)).toHaveCount(0);

    await replyRegion.getByRole('button', { name: '重试' }).click();
    await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`))
      .toHaveAttribute('data-located', 'true');
    // 显式重试成功后仍把目标带回视口，而不是留在失败提示的位置。
    await expect.poll(() => viewportTop(page, targetReplyId)).toBeLessThan(24);
    // 两次定位尝试：先失败、后成功；失败不是“不存在”。
    expect(api.requests.filter(request => request.kind === 'reply-location')).toHaveLength(2);
    expect(api.requests.filter(request => request.kind === 'replies')).toEqual([]);
  });

  test('普通详情入口不受影响：不请求任何定位端点也不高亮', async ({ page }) => {
    const api = await mockArchive(page);
    await page.goto(`/dynamics/${dynamicId}`);
    await expect(page.getByRole('region', { name: '评论区' }).getByRole('listitem').first()).toBeVisible();
    await expect(located(page)).toHaveCount(0);
    // 普通入口仍是 3 条 cursor 预览，没有精确目标的展开与页码。
    await expect(replyList(page).locator('> li')).toHaveCount(0);
    expect(api.requests).toEqual([]);
  });

  test('宽屏各宽度都不横向溢出，定位后可读', async ({ page }) => {
    await mockArchive(page);
    await page.goto(locatePath());
    await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`))
      .toHaveAttribute('data-located', 'true');
    for (const width of [768, 1024, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`)).toBeVisible();
      await expect(page.getByText('第七行边界 7')).toBeVisible();
    }
  });
});
