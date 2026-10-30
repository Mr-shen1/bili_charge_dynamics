// @projects mobile-chromium-archive
import { expect, test, type Page } from '@playwright/test';
import { scrollY } from './support';

// 窄屏楼中楼跑生产装配 + HTTP 传输替身：仍经过真实 Adapter 的页码映射与页面读取。
// 640px 分支、送达顶部、返回详情快照与迟到回调必须真实浏览器才能验证。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const target = { id: '7100', nickname: '阿蓝', avatar_url: null };
const rootId = '7050';
// 七行长文在 390px 宽度下必然超过六行；楼中楼正文不折叠，必须整段可见。
const longText = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：楼中楼正文直接展示，不新增折叠。`).join('\n');
const longUrl = `https://example.test/${'a'.repeat(80)}`;

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

function comment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    dynamic_id: '1001',
    author: commenter,
    published_at: archiveTime(1),
    text: `一级评论 ${id}`,
    like_count: 1,
    source_reply_count: 0,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
    ...overrides,
  };
}

/** 该动态作者在此楼最早的一条回复：嵌套目标 + 来源自带重复前缀。 */
function upReply() {
  return {
    id: '9100',
    author,
    parent_id: '9199',
    reply_to: target,
    published_at: archiveTime(2),
    text: '回复 @阿蓝: UP 的最早回复',
    like_count: 3,
  };
}

const rootComment = comment(rootId, {
  text: '被回复的根评论',
  is_pinned: true,
  source_reply_count: 25,
  like_count: 9,
  up_reply: upReply(),
  media: [{
    id: 'thread-image', owner: { type: 'comment', id: rootId }, status: 'success',
    public_url: '/thread-image.png', width: 800, height: 600,
  }],
});

const rootComments = [
  comment('7001', { text: '零回复的评论', source_reply_count: 0, up_reply: upReply() }),
  rootComment,
  comment('7051', { text: '无作者摘要的评论', source_reply_count: 8 }),
  comment('7052', { text: '未知回复数的评论', source_reply_count: null, up_reply: upReply() }),
  comment('7053', { text: longText, source_reply_count: 0 }),
];

function reply(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(9000 + index),
    dynamic_id: '1001',
    root_id: rootId,
    parent_id: rootId,
    author: commenter,
    reply_to: null,
    published_at: archiveTime(index),
    text: `回复 ${index}`,
    like_count: index,
    ...overrides,
  };
}

const replyOrder = Array.from({ length: 25 }, (_value, index) => reply(index + 1,
  index === 1 ? {
    parent_id: '9001', reply_to: target, text: '回复 @阿蓝: 嵌套目标与来源前缀',
  } : index === 2 ? { text: `${longText}\n${longUrl}` } : {}));

interface ReplyRequest {
  page: number | null;
  limit: number | null;
  cursor: string | null;
}

async function mockApi(page: Page, options: { replyDelay?: (request: ReplyRequest) => number } = {}) {
  const requests: ReplyRequest[] = [];
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body as Record<string, unknown> });
    if (url.pathname === '/api/archive/ups') return respond({ ups: [author] });
    if (url.pathname === '/api/archive/dynamics') return respond({ items: [dynamic()], next_cursor: null });
    if (url.pathname === '/api/archive/dynamics/1001') return respond(dynamic());
    if (/\/api\/archive\/dynamics\/1001\/comments$/.test(url.pathname)) {
      return respond({ items: rootComments, next_cursor: null });
    }
    if (url.pathname === `/api/archive/dynamics/1001/comments/${rootId}/replies`) {
      const pageParam = url.searchParams.get('page');
      const limit = url.searchParams.get('limit');
      const cursor = url.searchParams.get('cursor');
      const request = {
        page: pageParam === null ? null : Number(pageParam),
        limit: limit === null ? null : Number(limit),
        cursor,
      };
      requests.push(request);
      const delay = options.replyDelay?.(request) ?? 0;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      // 楼中楼只接受页码模式：固定每页 10 条、不带 cursor，响应带根评论与本页总量。
      if (request.page === null || request.cursor !== null || request.limit !== 10) {
        return respond({ error: { code: 'INVALID_INPUT' } }, 422);
      }
      const offset = (request.page - 1) * 10;
      return respond({
        items: replyOrder.slice(offset, offset + 10),
        next_cursor: null,
        count: replyOrder.length,
        root: rootComment,
        source_reply_count: 25,
        local_reply_count: replyOrder.length,
        replies_last_attempt: 'success',
      });
    }
    return respond({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return requests;
}

function commentItem(page: Page, id: string) {
  return page.locator(`[data-reading-id="comment:${id}"]`);
}

function threadList(page: Page) {
  return page.getByRole('list', { name: '相关回复' });
}

test.describe('窄屏 UP 回复预览与独立楼中楼', () => {
  test('按正来源数给入口：有摘要先展示该条，零或未知不出现；进入后按 1/2/3 页读', async ({ page }) => {
    const requests = await mockApi(page);
    await page.goto('/dynamics/1001');
    const region = page.getByRole('region', { name: '评论区' });
    await expect(region.getByRole('listitem')).toHaveCount(5);

    const withUp = commentItem(page, rootId);
    await expect(withUp.getByRole('button', { name: 'UP主等人 共25条回复' })).toBeVisible();
    // 摘要展示该动态作者的最早回复：UP 标识、目标与去重后的正文。
    await expect(withUp).toContainText('UP 的最早回复');
    await expect(withUp).toContainText('回复 阿蓝:');
    await expect(withUp).not.toContainText('回复 @阿蓝');
    await expect(withUp.getByText('UP主', { exact: true })).toHaveCount(1);
    // 窄屏不建内联回复区：进入前不读任何回复。
    expect(requests).toEqual([]);

    const withoutUp = commentItem(page, '7051');
    await expect(withoutUp.getByRole('button', { name: '共8条回复' })).toBeVisible();
    await expect(withoutUp).not.toContainText('UP主等人');

    for (const id of ['7001', '7052']) {
      await expect(commentItem(page, id).getByRole('button', { name: /条回复/ })).toHaveCount(0);
    }
    // 为返回后的详情快照留状态：展开长评论正文。
    await commentItem(page, '7053').getByRole('button', { name: '展开评论' }).click();
    await expect(commentItem(page, '7053').getByRole('button', { name: '收起评论' })).toBeVisible();

    await withUp.getByRole('button', { name: 'UP主等人 共25条回复' }).click();
    await expect(page).toHaveURL(new RegExp(`/dynamics/1001/comments/${rootId}$`));
    await expect(threadList(page).locator('> li')).toHaveCount(10);
    expect(requests.at(-1)).toEqual({ page: 1, limit: 10, cursor: null });
    await expect(page.getByRole('heading', { name: '相关回复共25条' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '3' })).toBeVisible();
    // 楼中楼重新挂载从顶部开始。
    await expect.poll(() => scrollY(page)).toBe(0);
    // 根评论与回复都直接显示正文；嵌套目标单独表达且剥离来源前缀。
    const rootArticle = page.getByRole('article', { name: '被回复的评论' });
    await expect(rootArticle).toContainText('被回复的根评论');
    await expect(rootArticle).toContainText('置顶');
    const nested = threadList(page).locator('> li').nth(1);
    await expect(nested).toContainText('回复 阿蓝:');
    await expect(nested).toContainText('嵌套目标与来源前缀');
    await expect(nested).not.toContainText('回复 @阿蓝');
    // 该页不渲染图片，也不新增折叠。
    await expect(page.locator('img[src="/thread-image.png"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /展开回复正文|展开评论/ })).toHaveCount(0);

    await page.getByRole('button', { name: '下一页' }).click();
    await expect(threadList(page).locator('> li')).toHaveCount(10);
    await expect(threadList(page).locator('> li').first()).toContainText('回复 11');
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(threadList(page).locator('> li')).toHaveCount(5);
    await expect(threadList(page).locator('> li').last()).toContainText('回复 25');
    expect(requests.map(request => request.page)).toEqual([1, 2, 3]);
    // 翻页落点：第 3 页的第一条被带到视口顶部（内容不够长时停在可滚动末端），
    // 这也是这次访问保存的位置。
    const pageThreeFirst = threadList(page).locator('> li').first();
    await expect.poll(async () => {
      const top = await pageThreeFirst.evaluate(node => node.getBoundingClientRect().top);
      const atEnd = await page.evaluate(() => Math.abs(
        window.scrollY - (document.documentElement.scrollHeight - window.innerHeight)) <= 1);
      return Math.round(top) <= 1 || atEnd;
    }).toBe(true);
    const pageThreeTop = await scrollY(page);
    expect(pageThreeTop).toBeGreaterThan(0);

    // 返回有来源的详情：详情自己的已读内容与展开状态保持不变。
    await page.getByRole('button', { name: '评论详情，返回动态详情' }).click();
    await expect(page).toHaveURL(/\/dynamics\/1001$/);
    await expect(region.getByRole('listitem')).toHaveCount(5);
    await expect(commentItem(page, '7053').getByRole('button', { name: '收起评论' })).toBeVisible();

    // 历史前进回到楼中楼：恢复**这次访问**自己的第 3 页与位置（会话返回与历史返回同一份快照），
    // 不重读第 1 页；直达/刷新没有快照，仍是新的第 1 页访问。
    const beforeForward = requests.length;
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/dynamics/1001/comments/${rootId}$`));
    await expect(threadList(page).locator('> li')).toHaveCount(5);
    expect(requests.slice(beforeForward)).toEqual([]);
    await expect(page.getByRole('navigation', { name: '回复分页' })
      .getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => scrollY(page)).toBe(pageThreeTop);
  });

  test('直达与刷新可打开楼中楼，返回用 replace 定位对应动态详情', async ({ page }) => {
    await mockApi(page);
    await page.goto(`/dynamics/1001/comments/${rootId}`);
    await expect(threadList(page).locator('> li')).toHaveCount(10);
    await expect(page.getByRole('heading', { name: '相关回复共25条' })).toBeVisible();
    expect(await scrollY(page)).toBe(0);

    await page.reload();
    await expect(threadList(page).locator('> li')).toHaveCount(10);
    await expect(page.getByRole('navigation', { name: '回复分页' })
      .getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');

    // 无详情来源：返回替换为动态详情，历史里不再留下楼中楼（回退不会再次进入该页）。
    await page.getByRole('button', { name: '评论详情，返回动态详情' }).click();
    await expect(page).toHaveURL(/\/dynamics\/1001$/);
    await page.goBack();
    await page.waitForTimeout(200);
    await expect(page).not.toHaveURL(new RegExp(`/comments/${rootId}$`));
  });

  test('翻页在途时离开，迟到结果不污染详情；再次进入仍从第 1 页开始', async ({ page }) => {
    const requests = await mockApi(page, { replyDelay: request => request.page === 2 ? 600 : 0 });
    await page.goto('/dynamics/1001');
    await commentItem(page, rootId).getByRole('button', { name: 'UP主等人 共25条回复' }).click();
    await expect(threadList(page).locator('> li')).toHaveCount(10);

    await page.getByRole('button', { name: '下一页' }).click();
    await page.getByRole('button', { name: '评论详情，返回动态详情' }).click();
    await expect(page).toHaveURL(/\/dynamics\/1001$/);
    await expect(page.getByRole('region', { name: '评论区' })).toBeVisible();

    // 等迟到响应真正到达：详情不出现错误，也不被楼中楼结果改写。
    await page.waitForTimeout(900);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(commentItem(page, rootId).getByRole('button', { name: 'UP主等人 共25条回复' })).toBeVisible();

    const before = requests.length;
    await page.goForward();
    await expect(threadList(page).locator('> li')).toHaveCount(10);
    expect(requests.slice(before)).toEqual([{ page: 1, limit: 10, cursor: null }]);
  });

  test('楼中楼的正文、分页与根评论在 360/390/768/1280 宽度下不横溢', async ({ page }) => {
    await mockApi(page);
    await page.goto(`/dynamics/1001/comments/${rootId}`);
    await expect(threadList(page).locator('> li')).toHaveCount(10);
    // 七行长文与超长 URL 直接展示，不折叠也不撑宽页面。
    await expect(threadList(page).locator('> li').nth(2)).toContainText('第七行边界 7');
    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
  });
});
