import { expect, test, type Page } from '@playwright/test';

// 楼中楼回复精确入口跑**实际归档 API + 本次运行独占的 SQLite**（backend/tests/live_app 的虚构上游）：
// 页面仍是生产装配，请求经 vite 的 /api 代理到真实后端。只替换来源 HTTP，
// 归档、评论定位与回复页码读取都是真实实现。与 tests/e2e/reply-location*.spec.ts 的替身场景分开记录。

const baseURL = 'http://127.0.0.1:4325';
const uid = '808';
const dynamicId = '800300';
const totalComments = 45;
// 45 条虚构根评论按点赞递减：最热顺序为 860001…860045，第一个根评论带 25 条虚构回复。
const rootId = String(860000 + 1);
const totalReplies = 25;
// 目标落在第 3 页（第 21 条），既不是首屏也不是第一页。
const lastPageReplyId = String(960000 + 22);
const firstPageReplyId = String(960000 + 3);
const commentsPath = `/api/archive/dynamics/${dynamicId}/comments`;
const repliesPath = `${commentsPath}/${rootId}/replies`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL });
  try {
    // 仅测试夹具：45 条虚构根评论 + 某个根下的 25 条虚构楼中楼，之后一切写入仍走真实归档链。
    expect((await api.post('/api/test/root-comments', { data: { dynamic: dynamicId } })).status()).toBe(200);
    expect((await api.post('/api/test/replies', { data: { dynamic: dynamicId, root: rootId } })).status())
      .toBe(200);
    // 与 comment-location 用例共享同一隔离数据库：已登记过该 UP 时不重复创建。
    const added = await api.post('/api/manage/ups', { data: { uid } });
    expect([201, 409]).toContain(added.status());
    expect((await api.patch(`/api/manage/ups/${uid}/monitor`,
      { data: { mode: 'specified', recent_n: 10, enabled: true } })).status()).toBe(200);
    expect((await api.post(`/api/manage/ups/${uid}/targets`, { data: { id: dynamicId } })).status()).toBe(201);
    const sync = await api.post('/api/sync/initial', { data: { uid } });
    expect(sync.status()).toBe(200);
    expect(await sync.json()).toMatchObject({ processed: 1, succeeded: 1 });
  } finally {
    await api.dispose();
  }
});

async function sourceRequests(page: Page): Promise<Record<string, number>> {
  const response = await page.request.get('/api/test/source-requests');
  return (await response.json()) as Record<string, number>;
}

async function archiveDocument(page: Page): Promise<Record<string, unknown>> {
  const response = await page.request.get(`/api/archive/dynamics/${dynamicId}`);
  return (await response.json()) as Record<string, unknown>;
}

function located(page: Page) {
  return page.locator('[data-located="true"]');
}

async function viewportTop(page: Page, replyId: string): Promise<number> {
  return page.locator(`[data-reading-id="reply:${rootId}:${replyId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top));
}

test('实际 API 定位读取：任意后续页回复可直接定位，且读取不触发采集或归档写入', async ({ page }) => {
  const archive = await archiveDocument(page);
  expect(archive.local_comment_count).toBe(totalComments);
  expect(archive.local_reply_count).toBe(totalReplies);
  // 目标确实不在第一页：第一页只有前 10 条。
  const first = await (await page.request.get(`${repliesPath}?page=1&limit=10`)).json();
  expect(first.items).toHaveLength(10);
  expect(first.items.some((item: { id: string }) => item.id === lastPageReplyId)).toBe(false);

  // 真实定位响应与真实页码响应同源：页码、条目与计数一致，末页就是最后一条所在页。
  const lastPage = await (await page.request.get(`${repliesPath}/${lastPageReplyId}/location`)).json();
  expect(lastPage.page).toBe(3);
  expect(lastPage.count).toBe(totalReplies);
  expect(lastPage.root.id).toBe(rootId);
  expect(lastPage.items.map((item: { id: string }) => item.id)).toEqual(
    Array.from({ length: 5 }, (_value, index) => String(960000 + 21 + index)));
  expect(lastPage.items).toEqual((await (await page.request.get(`${repliesPath}?page=3&limit=10`)).json()).items);
  const firstPage = await (await page.request.get(`${repliesPath}/${firstPageReplyId}/location`)).json();
  expect(firstPage.page).toBe(1);
  expect(firstPage.items).toHaveLength(10);
  // 跨楼与不存在的回复都按不存在处理，不暴露别楼内容。
  expect((await page.request.get(`${commentsPath}/${rootId}/replies/999999/location`)).status()).toBe(404);
  expect((await page.request.get(`${commentsPath}/860002/replies/${lastPageReplyId}/location`)).status())
    .toBe(404);

  const before = await sourceRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}/replies/${lastPageReplyId}/locate`);
  const replyList = page.locator(`[data-reading-id="comment:${rootId}"]`)
    .getByRole('list', { name: '回复列表' });
  await expect(replyList.locator('> li')).toHaveCount(5);
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${lastPageReplyId}"]`))
    .toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  // 定位落在目标回复本身，而不是楼层顶部或第一页。
  await expect.poll(() => viewportTop(page, lastPageReplyId)).toBeLessThan(24);
  // 页面渲染顺序就是实际 API 的定位响应（同一契约，不是前端重新拼的入口）。
  const rendered = await replyList.locator('> li').evaluateAll(items =>
    items.map(item => item.getAttribute('data-reading-id')));
  expect(rendered).toEqual(lastPage.items.map((item: { id: string }) => `reply:${rootId}:${item.id}`));
  await expect(page.locator(`[data-reading-id="comment:${rootId}"]`)
    .getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page');

  // 只读定位：不请求上游、不改变归档内容（真实 API + 隔离 SQLite 的无副作用证明）。
  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page)).toEqual(archive);

  // 窄屏刷新同样直达目标页，且不产生横向溢出。
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  await expect(page.getByRole('list', { name: '相关回复' }).locator('> li')).toHaveCount(5);
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${lastPageReplyId}"]`))
    .toHaveAttribute('data-located', 'true');
  // 末页只有 5 条，滚到底也放不到视口顶部：只要求目标真的进入视口，且没有回到页面顶部。
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${lastPageReplyId}"]`)).toBeInViewport();
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page)).toEqual(archive);
});

test('实际 API 目标不存在时明确提示并可返回对应动态', async ({ page }) => {
  const before = await sourceRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}/replies/999999/locate`);
  await expect(page.getByRole('region', { name: '定位结果' }).getByRole('status'))
    .toContainText('不存在或未归档');
  await expect(located(page)).toHaveCount(0);

  await page.getByRole('region', { name: '定位结果' }).getByRole('button', { name: '返回动态' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
  await expect(page.getByRole('region', { name: '评论区' }).getByRole('listitem').first()).toBeVisible();
  expect(await sourceRequests(page)).toEqual(before);
});
