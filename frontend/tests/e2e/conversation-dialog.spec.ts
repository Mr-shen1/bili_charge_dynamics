// @projects desktop-chromium-archive
import { expect, test, type Page } from '@playwright/test';

// 宽屏「查看对话」弹窗：生产装配 + HTTP 传输替身，仍经过真实 Adapter 与真实滚动。
// 整段对话在弹窗自己的滚动容器里读，不跳路由、不动背景页面的滚动与状态。

const author = { id: '123', nickname: '动态作者', avatar_url: null };
const commenter = { id: '7001', nickname: '评论作者', avatar_url: null };
const replier = { id: '7002', nickname: '回复作者', avatar_url: null };
const rootId = '7050';
const entryId = '9010';
const conversationCount = 25;

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
    source_comment_count: 1,
    local_comment_count: 1,
    media_sources: [],
    comment_locator: null,
    observed_version: null,
    synced_version: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    root_comments_last_attempt: 'success',
  };
}

function comment() {
  return {
    id: rootId,
    dynamic_id: '1001',
    author: commenter,
    published_at: archiveTime(1),
    text: '被回复的根评论',
    like_count: 3,
    source_reply_count: conversationCount,
    is_pinned: false,
    root_id: '0',
    parent_id: '0',
    comment_locator: null,
    media_sources: [],
  };
}

function reply(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(9000 + index),
    dynamic_id: '1001',
    root_id: rootId,
    parent_id: rootId,
    author: replier,
    reply_to: null,
    published_at: archiveTime(index),
    text: `回复 ${index}`,
    like_count: index,
    ...overrides,
  };
}

/** 第 1 页 10 条；第 10 条带对话投影（起点 9001，整段 25 条），入口因此落在整段中间。 */
const pageItems = Array.from({ length: 10 }, (_value, index) => reply(index + 1,
  index === 9 ? { id: entryId, conversation: { start_id: '9001', count: conversationCount, incomplete: false } }
    : {}));
const conversationItems = Array.from({ length: conversationCount }, (_value, index) => reply(index + 1));

async function mockApi(page: Page) {
  let conversationReads = 0;
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const respond = (body: unknown, status = 200) => route.fulfill({ status, json: body as Record<string, unknown> });
    if (url.pathname === '/api/archive/ups') return respond({ ups: [author] });
    if (url.pathname === '/api/archive/dynamics') return respond({ items: [dynamic()], next_cursor: null });
    if (url.pathname === '/api/archive/dynamics/1001') return respond(dynamic());
    if (url.pathname === '/api/archive/dynamics/1001/comments') {
      return respond({ items: [comment()], next_cursor: null });
    }
    if (url.pathname === `/api/archive/dynamics/1001/comments/${rootId}/replies`) {
      // 无 page 参数是宽屏的 3 条 cursor 预览（带展开入口）；带 page 才是页码模式。
      if (url.searchParams.get('page') === null) {
        return respond({
          items: pageItems.slice(0, 3),
          next_cursor: '3',
          source_reply_count: conversationCount,
          local_reply_count: conversationCount,
        });
      }
      return respond({
        items: pageItems,
        next_cursor: null,
        count: conversationCount,
        root: comment(),
        source_reply_count: conversationCount,
        local_reply_count: conversationCount,
        replies_last_attempt: 'success',
      });
    }
    if (url.pathname === `/api/archive/dynamics/1001/comments/${rootId}/replies/${entryId}/conversation`) {
      conversationReads += 1;
      return respond({
        dynamic_id: '1001',
        root_id: rootId,
        reply_id: entryId,
        start_id: '9001',
        incomplete: false,
        items: conversationItems,
        count: conversationCount,
        next_cursor: null,
      });
    }
    return respond({ error: { code: 'NOT_FOUND', message: '不存在' } }, 404);
  });
  return { reads: () => conversationReads };
}

/** 入口回复中心与弹窗可视区中心的距离（px）。 */
async function centerOffset(page: Page): Promise<number> {
  return page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.conversation-dialog__body');
    const entry = body?.querySelector<HTMLElement>('[data-conversation-entry="true"]');
    if (!body || !entry) return Number.POSITIVE_INFINITY;
    const box = body.getBoundingClientRect();
    const item = entry.getBoundingClientRect();
    return Math.abs((item.top - box.top) + item.height / 2 - body.clientHeight / 2);
  });
}

async function openDialog(page: Page) {
  await page.goto('/dynamics/1001');
  const section = page.getByRole('region', { name: '回复区' });
  await section.getByRole('button', { name: '展开回复' }).click();
  const entry = page.locator(`[data-reading-id="reply:${rootId}:${entryId}"]`)
    .getByRole('button', { name: '查看对话' });
  await expect(entry).toBeVisible();
  // 先把入口滚进视口再记基线：点击本身也会把目标滚进来，基线必须是点击后的位置。
  await entry.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  await entry.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  return { entry, before };
}

test('桌面点「查看对话」：弹窗整段呈现并定位入口，不跳路由', async ({ page }) => {
  const api = await mockApi(page);
  const { entry } = await openDialog(page);

  // 路由不变：仍是详情页，弹窗只是一个浮层。
  await expect(page).toHaveURL(/\/dynamics\/1001$/);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '对话' })).toBeVisible();
  const list = dialog.getByRole('list', { name: '对话内容' });
  await expect(list.locator('> li')).toHaveCount(conversationCount);
  await expect(dialog.getByText(`共 ${conversationCount} 条`)).toBeVisible();
  // 入口唯一且就是刚才点的那条，并落在弹窗可视区中央。
  await expect(dialog.locator('[data-conversation-entry="true"]')).toHaveCount(1);
  await expect(dialog.locator('[data-conversation-entry="true"]'))
    .toHaveAttribute('data-reading-id', `reply:${rootId}:${entryId}`);
  await expect(dialog.getByText('刚才查看')).toHaveCount(1);
  await expect.poll(() => centerOffset(page)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => document.querySelector<HTMLElement>('.conversation-dialog__body')!.scrollTop))
    .toBeGreaterThan(0);
  expect(api.reads()).toBe(1);
  await expect(entry).toBeVisible();
});

test('关闭弹窗：ESC 与关闭按钮都能关，焦点回到入口，背景页面状态与滚动不变', async ({ page }) => {
  await mockApi(page);
  const { entry, before } = await openDialog(page);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(entry).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  // 背景页面的回复区仍是展开的第 1 页，没有被卸载。
  const section = page.getByRole('region', { name: '回复区' });
  await expect(section.getByRole('list', { name: '回复列表' }).locator('> li')).toHaveCount(10);
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${entryId}"]`)
    .getByRole('button', { name: '查看对话' })).toBeFocused();

  // 再次打开再关闭（关闭按钮），同样回到详情页而不是留在遮罩上。
  await page.locator(`[data-reading-id="reply:${rootId}:${entryId}"]`)
    .getByRole('button', { name: '查看对话' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close this dialog' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).toHaveURL(/\/dynamics\/1001$/);
});

test('768 / 1280 宽度下弹窗不横溢，弹窗内按钮仍够高', async ({ page }) => {
  await mockApi(page);
  for (const width of [768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await openDialog(page);
    const report = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.conversation-dialog__body')!;
      const buttons = [...body.querySelectorAll('button')];
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflow: body.scrollWidth - body.clientWidth,
        shortButtons: buttons.filter(button => button.getBoundingClientRect().height < 43).length,
      };
    });
    expect(report.pageOverflow, `${width}px 弹窗不应让页面横溢`).toBeLessThanOrEqual(1);
    expect(report.bodyOverflow, `${width}px 弹窗内容不应横溢`).toBeLessThanOrEqual(1);
    expect(report.shortButtons, `${width}px 弹窗内按钮触控高度`).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  }
});
