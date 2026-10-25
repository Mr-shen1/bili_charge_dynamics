// @projects mobile-chromium-archive
import { expect, test, type Page } from '@playwright/test';
import { scrollY } from './support';

// 窄屏楼中楼回复精确入口跑生产装配 + HTTP 传输替身：640px 分支进入独立楼中楼页，
// 直达目标所在页、刷新、返回 replace、迟到响应与滚动落点必须真实浏览器才能验证。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const replier = { id: '7002', nickname: '回复作者', avatar_url: null };
const dynamicId = '1001';
const rootId = '7050';
const totalReplies = 25;
const targetReplyId = '9014';
// 七行长文在 390px 宽下必然超过六行：楼中楼正文不折叠，定位即可读整段。
const longReplyText = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：楼中楼正文直接展示，不新增折叠。`).join('\n');

const rootComment = {
  id: rootId,
  dynamic_id: dynamicId,
  author: commenter,
  published_at: '2026-03-01T10:03:04+08:00',
  text: '被定位回复所属的根评论',
  like_count: 9,
  source_reply_count: totalReplies,
  is_pinned: true,
  root_id: '0',
  parent_id: '0',
  comment_locator: null,
  media_sources: [],
};

function dynamic() {
  return {
    id: dynamicId,
    author,
    published_at: '2026-03-01T10:03:04+08:00',
    edit_status: 'unknown',
    text: '详情正文',
    content_state: 'success',
    last_attempt: 'success',
    source_comment_count: 5,
    local_comment_count: 5,
    media_sources: [],
    comment_locator: null,
    observed_version: null,
    synced_version: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    root_comments_last_attempt: 'success',
  };
}

const rootComments = [rootComment,
  ...[7051, 7052, 7053, 7054].map(id => ({ ...rootComment, id: String(id), is_pinned: false, source_reply_count: 0 }))];

function archiveTime(index: number): string {
  const epoch = Date.UTC(2026, 2, 1, 2, 3, 4) + 8 * 3_600_000 + index * 60_000;
  return `${new Date(epoch).toISOString().slice(0, 19)}+08:00`;
}

function reply(index: number) {
  return {
    id: String(9000 + index),
    dynamic_id: dynamicId,
    root_id: rootId,
    parent_id: rootId,
    author: replier,
    reply_to: null,
    published_at: archiveTime(index),
    // 目标回复（第 14 条，落在第 2 页）用七行正文：楼中楼不折叠，定位即可读。
    text: index === 14 ? longReplyText : `回复 ${index}`,
    like_count: index,
  };
}

const replyOrder = Array.from({ length: totalReplies }, (_value, index) => reply(index + 1));
const replyPage = (page: number) => replyOrder.slice((page - 1) * 10, (page - 1) * 10 + 10);

type ArchiveRequest =
  | { kind: 'replies'; page: number | null; limit: number | null; cursor: string | null }
  | { kind: 'reply-location'; replyId: string };

async function mockArchive(
  page: Page,
  options: { replyLocationFailures?: number; replyLocationDelay?: number } = {},
) {
  const requests: ArchiveRequest[] = [];
  let failures = 0;
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body as Record<string, unknown> });
    if (url.pathname === '/api/archive/ups') return respond({ ups: [author] });
    if (url.pathname === '/api/archive/dynamics') return respond({ items: [dynamic()], next_cursor: null });
    if (url.pathname === `/api/archive/dynamics/${dynamicId}`) return respond(dynamic());
    if (url.pathname === `/api/archive/dynamics/${dynamicId}/comments`) {
      return respond({ items: rootComments, next_cursor: null });
    }

    const location = url.pathname.match(
      new RegExp(`^/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies/([^/]+)/location$`));
    if (location) {
      requests.push({ kind: 'reply-location', replyId: location[1]! });
      if (options.replyLocationDelay) {
        await new Promise(resolve => setTimeout(resolve, options.replyLocationDelay));
      }
      if (failures < (options.replyLocationFailures ?? 0)) {
        failures += 1;
        return respond({ error: { code: 'STORAGE_UNAVAILABLE' } }, 503);
      }
      const index = replyOrder.findIndex(item => item.id === location[1]);
      if (index < 0) return respond({ error: { code: 'NOT_FOUND' } }, 404);
      const number = Math.floor(index / 10) + 1;
      return respond({
        items: replyPage(number), next_cursor: null, page: number,
        count: totalReplies, root: rootComment, source_reply_count: totalReplies,
        local_reply_count: totalReplies, replies_last_attempt: 'success',
      });
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
      const number = pageParam === null ? 1 : Number(pageParam);
      return respond({
        items: replyPage(number), next_cursor: null, count: totalReplies, root: rootComment,
        source_reply_count: totalReplies, local_reply_count: totalReplies, replies_last_attempt: 'success',
      });
    }
    return respond({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return requests;
}

const locatePath = (replyId = targetReplyId) => `/dynamics/${dynamicId}/comments/${rootId}/replies/${replyId}/locate`;

function threadList(page: Page) {
  return page.getByRole('list', { name: '相关回复' });
}

function located(page: Page) {
  return page.locator('[data-located="true"]');
}

async function viewportTop(page: Page, replyId: string): Promise<number> {
  return page.locator(`[data-reading-id="reply:${rootId}:${replyId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top));
}

test.describe('窄屏楼中楼回复精确链接', () => {
  test('直达独立楼中楼并显示目标所在页：高亮目标、停在第 2 页，不回第 1 页也不回页面顶部', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(locatePath());

    const target = page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`);
    await expect(target).toBeVisible();
    // 只有一次定位读取：不先读第 1 页，也不因此渲染全部回复。
    expect(requests).toEqual([{ kind: 'reply-location', replyId: targetReplyId }]);
    await expect(threadList(page).locator('> li')).toHaveCount(10);
    await expect(located(page)).toHaveCount(1);
    await expect(target).toHaveAttribute('aria-current', 'true');
    // 落点是目标回复本身，不是页面顶部。
    await expect.poll(() => viewportTop(page, targetReplyId)).toBeLessThan(24);
    expect(await scrollY(page)).toBeGreaterThan(0);
    // 根评论上下文仍在页面上方，正文不折叠、可直接阅读。
    await expect(page.getByRole('article', { name: '被回复的评论' })).toContainText('被定位回复所属的根评论');
    await expect(target).toContainText('第七行边界 7');
    await expect(page.getByRole('button', { name: /展开回复正文|展开评论/ })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '回复分页' })
      .getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: '相关回复共25条' })).toBeVisible();

    // 定位后的翻页仍是原页内替换。
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(threadList(page).locator('> li')).toHaveCount(5);
    expect(requests.at(-1)).toEqual({ kind: 'replies', page: 3, limit: 10, cursor: null });
  });

  test('刷新后仍直达目标页，返回替换为对应动态详情', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(locatePath());
    await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`))
      .toHaveAttribute('data-located', 'true');

    await page.reload();
    await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`))
      .toHaveAttribute('data-located', 'true');
    await expect.poll(() => viewportTop(page, targetReplyId)).toBeLessThan(24);
    expect(requests.filter(request => request.kind === 'reply-location')).toHaveLength(2);
    expect(requests.filter(request => request.kind === 'replies')).toEqual([]);

    // 无详情来源：返回替换为对应动态详情，不在历史里留下精确地址。
    await page.getByRole('button', { name: '返回评论' }).click();
    await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
    await page.goBack();
    await page.waitForTimeout(200);
    await expect(page).not.toHaveURL(/\/locate$/);
  });

  test('目标不存在时明确提示并可返回对应动态', async ({ page }) => {
    await mockArchive(page);
    await page.goto(locatePath('9999'));
    const notice = page.getByRole('region', { name: '定位结果' });
    await expect(notice.getByRole('status')).toContainText('不存在或未归档');
    await expect(located(page)).toHaveCount(0);
    await expect(threadList(page)).toHaveCount(0);

    await notice.getByRole('button', { name: '返回动态' }).click();
    await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
  });

  test('临时失败可局部重试，重试成功后才定位高亮', async ({ page }) => {
    const requests = await mockArchive(page, { replyLocationFailures: 1 });
    await page.goto(locatePath());
    await expect(page.getByRole('alert')).toContainText('读取失败');
    await expect(located(page)).toHaveCount(0);

    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`))
      .toHaveAttribute('data-located', 'true');
    // 显式重试成功后仍把目标带回视口，而不是留在失败提示的位置。
    await expect.poll(() => viewportTop(page, targetReplyId)).toBeLessThan(24);
    expect(requests.filter(request => request.kind === 'reply-location')).toHaveLength(2);
  });

  test('普通楼中楼入口仍从第 1 页读并回到页面顶部', async ({ page }) => {
    const requests = await mockArchive(page);
    await page.goto(`/dynamics/${dynamicId}/comments/${rootId}`);
    await expect(threadList(page).locator('> li')).toHaveCount(10);
    expect(requests).toEqual([{ kind: 'replies', page: 1, limit: 10, cursor: null }]);
    await expect(located(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '回复分页' })
      .getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
    expect(await scrollY(page)).toBe(0);
  });

  test('定位在途时离开，迟到结果不污染详情', async ({ page }) => {
    await mockArchive(page, { replyLocationDelay: 600 });
    await page.goto(locatePath());
    await expect(page.getByRole('button', { name: '返回评论' })).toBeVisible();
    await page.getByRole('button', { name: '返回评论' }).click();
    await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
    await expect(page.getByRole('region', { name: '评论区' })).toBeVisible();

    // 等迟到响应真正到达：详情不出现错误，也不被楼中楼结果改写。
    await page.waitForTimeout(900);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(located(page)).toHaveCount(0);
  });

  test('窄屏各宽度都不横向溢出，定位后可读', async ({ page }) => {
    await mockArchive(page);
    await page.goto(locatePath());
    await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`))
      .toHaveAttribute('data-located', 'true');
    for (const width of [360, 390, 412]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await expect(page.locator(`[data-reading-id="reply:${rootId}:${targetReplyId}"]`)).toBeVisible();
    }
  });
});
