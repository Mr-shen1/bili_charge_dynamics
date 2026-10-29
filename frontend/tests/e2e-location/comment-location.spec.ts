import { expect, test, type Page } from '@playwright/test';

// 一级评论精确入口跑**实际归档 API + 本次运行独占的 SQLite**（backend/tests/live_app 的虚构上游）：
// 页面仍是生产装配，请求经 vite 的 /api 代理到真实后端。上传只替换来源 HTTP，不替换归档与读取。
// 与 tests/e2e/comment-location.spec.ts 的 HTTP 替身场景分开记录，互不替代。

const baseURL = 'http://127.0.0.1:4325';
const uid = '808';
const dynamicId = '800300';
const total = 45;
// 45 条虚构根评论点赞与时间同向递减：按热度/按时间顺序都是 860001…860045，目标落在第二批。
const targetId = String(860000 + 25);
const commentsPath = `/api/archive/dynamics/${dynamicId}/comments`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL });
  try {
    // 仅测试夹具：为 800300 启用 45 条虚构根评论，之后一切写入仍走真实归档链。
    expect((await api.post('/api/test/root-comments', { data: { dynamic: dynamicId } })).status()).toBe(200);
    expect((await api.post('/api/manage/ups', { data: { uid } })).status()).toBe(201);
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

async function viewportTop(page: Page, rootId: string): Promise<number> {
  return page.locator(`[data-reading-id="comment:${rootId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top));
}

test('实际 API 定位读取：后续批目标可直开定位，且读取不触发采集或归档写入', async ({ page }) => {
  const archive = await archiveDocument(page);
  expect(archive.local_comment_count).toBe(total);
  // 目标确实不在首批：页面默认按时间，首批只到第 20 条。
  const first = await (await page.request.get(`${commentsPath}?sort=latest&limit=20`)).json();
  expect(first.items).toHaveLength(20);
  expect(first.items.some((item: { id: string }) => item.id === targetId)).toBe(false);

  const before = await sourceRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${targetId}/locate`);
  const region = page.getByRole('region', { name: '评论区' });
  await expect(region.getByRole('listitem')).toHaveCount(20);
  await expect(page.locator(`[data-reading-id="comment:${targetId}"]`)).toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  // 定位落在目标评论本身，而不是页首。
  await expect.poll(() => viewportTop(page, targetId)).toBeLessThan(24);

  // 页面渲染的顺序与实际 API 的定位响应一致（同一契约，不是重新拼出来的入口）。
  const location = await (await page.request.get(`${commentsPath}/${targetId}/location?sort=latest`)).json();
  const rendered = await region.getByRole('listitem').evaluateAll(items =>
    items.map(item => item.getAttribute('data-reading-id')));
  expect(rendered).toEqual(location.items.map((item: { id: string }) => `comment:${item.id}`));

  // 只读定位：不请求上游、不改变归档内容（真实 API + 隔离 SQLite 的无副作用证明）。
  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page)).toEqual(archive);

  // 窄屏刷新同样直达目标，且不产生横向溢出。
  await page.setViewportSize({ width: 390, height: 800 });
  await page.reload();
  const compact = page.getByRole('region', { name: '评论区' });
  await expect(compact.getByRole('listitem')).toHaveCount(20);
  await expect(page.locator(`[data-reading-id="comment:${targetId}"]`)).toHaveAttribute('data-located', 'true');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  expect(await sourceRequests(page)).toEqual(before);
});

test('实际 API 目标不存在时明确提示并可返回对应动态', async ({ page }) => {
  const before = await sourceRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/999999/locate`);
  const region = page.getByRole('region', { name: '评论区' });
  await expect(region.getByRole('status').filter({ hasText: '不存在或未归档' })).toBeVisible();
  await expect(located(page)).toHaveCount(0);

  await region.getByRole('button', { name: '返回动态' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}$`));
  await expect(page.getByRole('region', { name: '评论区' }).getByRole('listitem')).toHaveCount(20);
  expect(await sourceRequests(page)).toEqual(before);
});
