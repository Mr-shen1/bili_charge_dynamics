// @projects desktop-chromium-archive, mobile-chromium-archive
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { commentSort, isCompact, switchCommentSort } from './support';

// 桌面卡片内联评论：生产装配 + HTTP 传输替身，仍经过真实 Adapter 的 DTO 映射。
// 断言只看可访问名称、URL 与可见内容，不依赖列表快照等私有状态。
// 窄屏保持既有入口（站内进入详情评论区），不在列表里另开一套内联评论。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const replyAuthor = { id: '7002', nickname: '回复作者', avatar_url: null };

function dynamic(id: string, commentCount: number) {
  return {
    id,
    author,
    published_at: '2026-03-01T10:03:04+08:00',
    edit_status: 'unknown',
    text: `动态正文 ${id}`,
    content_state: 'success',
    last_attempt: 'success',
    source_comment_count: commentCount,
    local_comment_count: commentCount,
    media_sources: [],
    comment_locator: null,
    observed_version: null,
    synced_version: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    root_comments_last_attempt: 'success',
  };
}

function comment(dynamicId: string, index: number, sort: 'latest' | 'hot', replyCount = 0) {
  return {
    id: `${dynamicId}0${index}`,
    dynamic_id: dynamicId,
    author: commenter,
    published_at: '2026-03-01T10:03:04+08:00',
    text: `${dynamicId} ${sort === 'latest' ? '时间' : '热度'}评论 ${index}`,
    like_count: index,
    source_reply_count: replyCount,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
  };
}

function reply(dynamicId: string, rootId: string, index: number) {
  return {
    id: `${rootId}9${String(index).padStart(2, '0')}`,
    dynamic_id: dynamicId,
    root_id: rootId,
    parent_id: rootId,
    author: replyAuthor,
    reply_to: null,
    published_at: '2026-03-01T10:03:04+08:00',
    text: `${rootId} 的回复 ${index}`,
    like_count: index,
  };
}

function rootComment(dynamicId: string, rootId: string, replyCount: number) {
  return {
    ...comment(dynamicId, 1, 'latest', replyCount),
    id: rootId,
    text: `${dynamicId} 时间评论 1`,
  };
}

/** 两条动态的归档读取：评论按 sort 返回不同批次，回复按 cursor/页码返回。 */
async function mockApi(page: Page | BrowserContext) {
  const requests: { path: string; sort: string | null; cursor: string | null; page: string | null }[] = [];
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const list = /^\/api\/archive\/dynamics\/([^/]+)\/comments$/.exec(path);
    const replies = /^\/api\/archive\/dynamics\/([^/]+)\/comments\/([^/]+)\/replies$/.exec(path);
    if (path === '/api/archive/ups') {
      await route.fulfill({ json: { ups: [author] } });
      return;
    }
    if (path === '/api/archive/dynamics') {
      await route.fulfill({ json: { items: [dynamic('1001', 45), dynamic('1002', 46)], next_cursor: null } });
      return;
    }
    if (list && list[1]) {
      const dynamicId = list[1];
      const sort = url.searchParams.get('sort');
      const cursor = url.searchParams.get('cursor');
      requests.push({ path, sort, cursor, page: null });
      const ordered = sort === 'latest' ? 'latest' : 'hot';
      const offset = cursor === null ? 0 : Number(cursor.split(':').at(-1));
      const items = Array.from({ length: offset === 0 ? 4 : 2 }, (_value, index) => comment(
        dynamicId, offset + index + 1, ordered as 'latest' | 'hot', offset + index === 0 ? 25 : 0,
      ));
      await route.fulfill({
        json: { items, next_cursor: offset === 0 ? `${ordered}:4` : null },
      });
      return;
    }
    const detail = /^\/api\/archive\/dynamics\/([^/]+)$/.exec(path);
    if (detail && detail[1]) {
      await route.fulfill({ json: dynamic(detail[1], detail[1] === '1001' ? 45 : 46) });
      return;
    }
    if (replies && replies[1] && replies[2]) {
      const dynamicId = replies[1]!;
      const rootId = replies[2]!;
      const pageParam = url.searchParams.get('page');
      const cursor = url.searchParams.get('cursor');
      requests.push({ path, sort: null, cursor, page: pageParam });
      const root = rootComment(dynamicId, rootId, 25);
      if (pageParam === null) {
        await route.fulfill({
          json: {
            items: Array.from({ length: 3 }, (_value, index) => reply(dynamicId, rootId, index + 1)),
            next_cursor: `${rootId}:3`,
            root,
          },
        });
        return;
      }
      const start = (Number(pageParam) - 1) * 10;
      await route.fulfill({
        json: {
          items: Array.from({ length: 10 }, (_value, index) => reply(dynamicId, rootId, start + index + 1)),
          next_cursor: null,
          root,
          count: 25,
          local_reply_count: 25,
          source_reply_count: 25,
        },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
  });
  return requests;
}

function card(page: Page, index: number) {
  return page.getByRole('article').nth(index);
}

/** 只数一级评论：嵌套的回复列表也是 listitem，不能直接按区域计数。 */
function rootComments(region: Locator) {
  return region.locator('[aria-label="一级评论"] > li');
}

async function noOverflow(page: Page, label: string) {
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1), { message: label }).toBe(true);
}

test('桌面两张卡片同时展开评论：列表与 URL 不跳走，排序与回复页码各自独立', async ({ page }) => {
  const requests = await mockApi(page.context());
  await page.goto('/');
  // 视口判定要在应用页面里做：about:blank 没有 viewport meta，移动模拟下宽度不可比。
  test.skip(await isCompact(page), '窄屏保持站内详情入口，由下一个用例覆盖');
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('article')).toHaveCount(2);

  // 第一张卡片：在当前卡片下方展开，URL 与列表都不跳走。
  await card(page, 0).getByRole('button', { name: '来源评论 45' }).click();
  const first = card(page, 0).getByRole('region', { name: '评论区' });
  await expect(rootComments(first)).toHaveCount(4);
  await expect(first.getByText('1001 时间评论 1')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(card(page, 1).getByRole('region', { name: '评论区' })).toHaveCount(0);

  await card(page, 1).getByRole('button', { name: '来源评论 46' }).click();
  const second = card(page, 1).getByRole('region', { name: '评论区' });
  await expect(rootComments(second)).toHaveCount(4);
  await expect(second.getByText('1002 时间评论 1')).toBeVisible();

  // 只切换第一张卡片的排序：第二张仍是自己的按时间批次。
  await switchCommentSort(first);
  await expect(commentSort(first, 'hot')).toBeVisible();
  await expect(first.getByText('1001 热度评论 1')).toBeVisible();
  await expect(commentSort(second, 'latest')).toBeVisible();
  await expect(second.getByText('1002 时间评论 1')).toBeVisible();
  expect(requests.filter(request => request.path.endsWith('/comments')).map(request => ({
    path: request.path, sort: request.sort, cursor: request.cursor,
  }))).toEqual([
    { path: '/api/archive/dynamics/1001/comments', sort: 'latest', cursor: null },
    { path: '/api/archive/dynamics/1002/comments', sort: 'latest', cursor: null },
    { path: '/api/archive/dynamics/1001/comments', sort: 'hot', cursor: null },
  ]);

  // 第一张卡片追加下一批：第二张不跟着追加。
  await first.getByRole('button', { name: '加载更多评论' }).click();
  await expect(rootComments(first)).toHaveCount(6);
  await expect(rootComments(second)).toHaveCount(4);

  // 回复页码独立：第一张展开楼中楼读第 1 页，第二张仍是 3 条预览。
  await rootComments(first).first().getByRole('button', { name: '展开回复' }).click();
  const firstRoot = rootComments(first).first();
  await expect(firstRoot.getByRole('list', { name: '回复列表' }).getByRole('listitem')).toHaveCount(10);
  await expect(firstRoot.getByRole('button', { name: '下一页' })).toBeVisible();
  const secondRoot = rootComments(second).first();
  await expect(secondRoot.getByRole('list', { name: '回复列表' }).getByRole('listitem')).toHaveCount(3);
  await expect(secondRoot.getByRole('navigation', { name: '回复分页' })).toHaveCount(0);

  // 关闭预览、选中文本与点击评论正文都不触发动态正文导航。
  await second.getByText('1002 时间评论 2').click();
  await page.getByRole('heading', { name: /评论 46/ }).click();
  await expect(page).toHaveURL(/\/$/);

  // 两个宽度都不横向溢出。
  await noOverflow(page, '1280px 列表内评论');
  await page.setViewportSize({ width: 768, height: 900 });
  await noOverflow(page, '768px 列表内评论');
  await expect(card(page, 0).getByRole('region', { name: '评论区' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });

  // 再次点击收起，焦点回到该卡片的评论入口。
  await card(page, 1).getByRole('button', { name: '来源评论 46' }).click();
  await expect(page.getByRole('region', { name: '评论区' })).toHaveCount(1);
  expect(await card(page, 1).getByRole('button', { name: '来源评论 46' })
    .evaluate(node => node === document.activeElement)).toBe(true);
  // 收起后的位置落在入口附近，正文与列表没有被收起动作带走。
  await expect(card(page, 0).getByRole('region', { name: '评论区' })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('桌面向导正文打开新标签：原列表的展开、排序、回复页码与位置都不动', async ({ page }) => {
  const requests = await mockApi(page.context());
  await page.goto('/');
  test.skip(await isCompact(page), '窄屏不提供内联评论，站内入口由窄屏用例覆盖');
  await page.setViewportSize({ width: 1280, height: 900 });
  await card(page, 0).getByRole('button', { name: '来源评论 45' }).click();
  await card(page, 1).getByRole('button', { name: '来源评论 46' }).click();
  const first = card(page, 0).getByRole('region', { name: '评论区' });
  await switchCommentSort(first);
  await expect(commentSort(first, 'hot')).toBeVisible();
  await expect(first.getByText('1001 热度评论 1')).toBeVisible();
  // 第一张卡片的楼中楼展开并翻到第 2 页：新标签不得把它重置回第 1 页。
  const root = rootComments(first).first();
  await root.getByRole('button', { name: '展开回复' }).click();
  const replyList = root.getByRole('list', { name: '回复列表' });
  await expect(replyList.getByRole('listitem')).toHaveCount(10);
  await root.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '2' }).click();
  await expect(root.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '2' }))
    .toHaveAttribute('aria-current', 'page');
  // 把第二张卡片带到视口里再滚动到非零位置：点击本身不会再把列表滚回顶部。
  await card(page, 1).evaluate(element => {
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 100);
  });
  const beforeScroll = await page.evaluate(() => Math.round(window.scrollY));
  expect(beforeScroll).toBeGreaterThan(0);
  const beforeList = requests.filter(request => request.path === '/api/archive/dynamics').length;

  // 卡片正文在独立标签页打开详情：本标签的 URL、滚动与两张卡片的评论状态都留在原地。
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: '阅读全文 1002' }).click({ position: { x: 8, y: 8 } }),
  ]);
  await expect(popup).toHaveURL(/\/dynamics\/1002$/);
  await expect(popup).toHaveTitle('动态详情');
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(popup.locator('.detail-card')).toContainText('动态正文 1002');
  // 新标签自己读详情与评论，不依赖原标签内存；正常桌面详情没有页头与返回按钮。
  await expect(popup.getByRole('region', { name: '评论区' })).toBeVisible();
  await expect(popup.getByRole('button', { name: '‹ 动态列表' })).toHaveCount(0);
  // 新标签打开期间，原列表的位置与两卡片的阅读状态都没有被改动。
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(beforeScroll);
  const keptFirst = card(page, 0).getByRole('region', { name: '评论区' });
  const keptSecond = card(page, 1).getByRole('region', { name: '评论区' });
  await expect(commentSort(keptFirst, 'hot')).toBeVisible();
  await expect(keptFirst.getByText('1001 热度评论 1')).toBeVisible();
  await expect(commentSort(keptSecond, 'latest')).toBeVisible();
  await expect(keptSecond.getByText('1002 时间评论 1')).toBeVisible();
  await expect(keptFirst.locator('[aria-label="回复列表"]').getByRole('listitem')).toHaveCount(10);
  await expect(keptFirst.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '2' }))
    .toHaveAttribute('aria-current', 'page');

  // 刷新新标签仍是同一动态与同一排序语义（详情自己按时间读一级评论）。
  await popup.reload();
  await expect(popup.locator('.detail-card')).toContainText('动态正文 1002');
  await expect(popup).toHaveTitle('动态详情');
  await popup.close();

  // 原标签没有因为开新标签而重读列表（列表请求数不变）。
  expect(requests.filter(request => request.path === '/api/archive/dynamics').length).toBe(beforeList);
  await expect(commentSort(keptFirst, 'hot')).toBeVisible();
});

test('窄屏保持原入口：卡片评论进入详情评论区，列表里不出现内联评论', async ({ page }) => {
  await mockApi(page.context());
  await page.goto('/');
  test.skip(!(await isCompact(page)), '宽屏走列表内展开，由桌面用例覆盖');
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.locator('[data-comment-region]')).toHaveCount(0);

  await card(page, 0).getByRole('button', { name: '来源评论 45' }).click();
  await expect(page).toHaveURL(/\/dynamics\/1001$/);
  const region = page.getByRole('region', { name: '评论区' });
  await expect(rootComments(region)).toHaveCount(4);
  await expect(region.getByText('1001 时间评论 1')).toBeVisible();

  // 返回列表仍是窄屏入口：没有任何卡片评论面板额外展开。
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.locator('[data-comment-region]')).toHaveCount(0);
  await noOverflow(page, '窄屏列表');
});
