import { expect, test, type Page } from '@playwright/test';

// 05：从**实际归档链**驱动飞书替身，取楼中楼回复消息里真实生成的链接进生产浏览器读取。
// 后端是 backend/tests/live_app（虚构上游 + 本次运行独占 SQLite），通知走真实 Dispatcher/
// 发件箱/消息模板；页面是生产装配。链接从投递产物里取，不在测试里另拼一套入口。

const uid = '808';
const dynamicId = '800300';
// 第一个根评论带 25 条虚构回复（10/10/5 分页）。“刚发表”的回复按发表时间排序落在最后，
// 因此目标固定在第 3 页（末页 5 条），既不是预览 3 条也不是第一页。
const rootId = '860001';
const replyIndex = 14;
const replyId = String(960000 + replyIndex);
const lastPageSize = 5;
const commentsPath = `/api/archive/dynamics/${dynamicId}/comments`;
const repliesPath = `${commentsPath}/${rootId}/replies`;

test.describe.configure({ mode: 'serial' });

let deliveredLink = '';
let messageText = '';

function payloadLink(payload: unknown): string {
  const content = (payload as {
    content: { post: { zh_cn: { content: Array<Array<{ tag?: string; href?: string }>> } } };
  }).content.post.zh_cn.content;
  return content.flat().find(item => item.tag === 'a')?.href ?? '';
}

function payloadText(payload: unknown): string {
  const content = (payload as { content: { post: { zh_cn: { content: Array<Array<{ text?: string }>> } } } })
    .content.post.zh_cn.content;
  return content.map(paragraph => paragraph.map(node => node.text ?? '').join('')).join('\n');
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4326' });
  try {
    // 与本项目的一级评论用例共享同一隔离数据库：已登记过的 UP/目标不重复创建。
    expect([201, 409]).toContain((await api.post('/api/manage/ups', { data: { uid } })).status());
    expect((await api.patch(`/api/manage/ups/${uid}/monitor`,
      { data: { mode: 'specified', recent_n: 10, enabled: true } })).status()).toBe(200);
    // 45 条虚构一级评论（都不算“刚发表”，因此只有回复会产生事件）+ 该楼 25 条虚构回复，
    // 其中第 14 条“刚发表”且作者就是该动态所属 UP → 真实路由同时进 UP 群与全员群。
    expect((await api.post('/api/test/root-comments',
      { data: { dynamic: dynamicId } })).status()).toBe(200);
    expect((await api.post('/api/test/replies',
      { data: { dynamic: dynamicId, root: rootId, fresh: [replyIndex] } })).status()).toBe(200);
    expect([201, 409]).toContain(
      (await api.post(`/api/manage/ups/${uid}/targets`, { data: { id: dynamicId } })).status());
    const sync = await api.post('/api/sync/initial', { data: { uid } });
    expect(sync.status()).toBe(200);
    expect(await sync.json()).toMatchObject({ processed: 1, succeeded: 1 });

    const notified = await api.post('/api/test/notify');
    expect(notified.status()).toBe(200);
    const delivered = (await notified.json()).delivered as Array<{ url: string; payload: unknown }>;
    // 只有那条回复具备资格：UP 本人 → 两个群、同一个实际链接。
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered.map(item => item.url)).size).toBe(2);
    const links = delivered.map(item => payloadLink(item.payload));
    expect(new Set(links).size).toBe(1);
    deliveredLink = links[0] ?? '';
    messageText = delivered[0] ? payloadText(delivered[0].payload) : '';
  } finally {
    await api.dispose();
  }
});

function located(page: Page) {
  return page.locator('[data-located="true"]');
}

test('投递产物链接在宽屏直接展开到目标回复所在页并定位高亮', async ({ page }) => {
  expect(deliveredLink).toBe(
    `http://127.0.0.1:4326/dynamics/${dynamicId}/comments/${rootId}/replies/${replyId}/locate`);
  // 链接携带完整定位身份，消息正文保留来源换行与“回复 @”上下文。
  expect(messageText).toContain(`动态：${dynamicId}`);
  expect(messageText).toContain('内容：虚构回复 14\n第二行：换行与 emoji 🙂');

  // 目标确实不在第一页：真实页码接口的第 1 页里没有它，定位读取给出的页码就是末页。
  const first = await (await page.request.get(`${repliesPath}?page=1&limit=10`)).json();
  expect(first.items).toHaveLength(10);
  expect(first.items.some((item: { id: string }) => item.id === replyId)).toBe(false);
  const locatedPage = await (await page.request.get(`${repliesPath}/${replyId}/location`)).json();
  expect(locatedPage.page).toBe(3);
  expect(locatedPage.items.map((item: { id: string }) => item.id)).toContain(replyId);

  await page.goto(deliveredLink);
  const thread = page.locator(`[data-reading-id="comment:${rootId}"]`);
  const list = thread.getByRole('list', { name: '回复列表' });
  await expect(list.locator('> li')).toHaveCount(lastPageSize);
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${replyId}"]`))
    .toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  // 定位落在目标回复本身，不在楼层顶部或第一页。
  await expect.poll(() => page.locator(`[data-reading-id="reply:${rootId}:${replyId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top))).toBeLessThan(24);
  await expect(thread.getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page');
  // 打开消息链接不触发采集：归档仍是初始化时的那一份。
  const archive = await (await page.request.get(`/api/archive/dynamics/${dynamicId}`)).json();
  expect(archive.local_reply_count).toBe(25);
});

test('同一条投递链接在窄屏刷新后仍直达该回复所在页', async ({ page }) => {
  const sourceBefore = await (await page.request.get('/api/test/source-requests')).json();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(deliveredLink);
  await page.reload();
  await expect(page.getByRole('list', { name: '相关回复' }).locator('> li')).toHaveCount(lastPageSize);
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${replyId}"]`))
    .toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${replyId}"]`)).toBeInViewport();
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  // 精确定位只读归档：不请求上游、不改归档内容。
  expect(await (await page.request.get('/api/test/source-requests')).json()).toEqual(sourceBefore);
});
