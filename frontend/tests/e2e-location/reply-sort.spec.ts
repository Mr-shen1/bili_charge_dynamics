import { expect, test, type Page } from '@playwright/test';

// 05：回复页码的时间/热度排序跑**实际归档 API + 本次运行独占的 SQLite**
// （backend/tests/live_app 的虚构上游）：归档、排序与页码都是真实实现，页面是生产装配。
// 虚构回复的点赞随序号递增，因此热度第 1 页正好是时间序第 3 页的尾部：
// 只用当前页排序或前端重排都无法通过这里的断言。

const baseURL = 'http://127.0.0.1:4325';
const uid = '808';
const dynamicId = '800300';
const rootId = String(860000 + 1);
const repliesPath = `/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies`;
const firstTimeId = String(960000 + 1);
const topLikedId = String(960000 + 25);
const timeFirstPage = Array.from({ length: 10 }, (_value, index) => String(960000 + 1 + index));
const hotFirstPage = Array.from({ length: 10 }, (_value, index) => String(960000 + 25 - index));
// 通知定位仍按时间序：目标在第 3 页。
const locatedId = String(960000 + 22);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL });
  try {
    // 仅测试夹具：45 条虚构根评论 + 25 条虚构楼中楼，之后一切读取仍走真实归档链。
    expect((await api.post('/api/test/root-comments', { data: { dynamic: dynamicId } })).status()).toBe(200);
    expect((await api.post('/api/test/replies', { data: { dynamic: dynamicId, root: rootId } })).status())
      .toBe(200);
    // 与同一项目内的定位用例共享隔离数据库：已登记过的 UP 与目标不重复创建。
    const added = await api.post('/api/manage/ups', { data: { uid } });
    expect([201, 409]).toContain(added.status());
    expect((await api.patch(`/api/manage/ups/${uid}/monitor`,
      { data: { mode: 'specified', recent_n: 10, enabled: true } })).status()).toBe(200);
    const targets = await api.get(`/api/manage/ups/${uid}/targets`);
    if (targets.ok()) {
      const saved = await targets.json();
      if (!saved.targets.some((target: { id: string }) => target.id === dynamicId)) {
        expect((await api.post(`/api/manage/ups/${uid}/targets`, { data: { id: dynamicId } })).status())
          .toBe(201);
      }
    }
    expect((await api.post('/api/sync/initial', { data: { uid } })).status()).toBe(200);
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

interface ReplyPage {
  items: { id: string; like_count: number | null }[];
  count: number;
}

async function pageOf(page: Page, number: number, sort?: string): Promise<ReplyPage> {
  const query = new URLSearchParams({ page: String(number), limit: '10' });
  if (sort !== undefined) query.set('sort', sort);
  return (await (await page.request.get(`${repliesPath}?${query}`)).json()) as ReplyPage;
}

function ids(batch: ReplyPage): string[] {
  return batch.items.map(item => item.id);
}

test('真实 HTTP 契约：时间序默认不变，热度作用于完整本地集合，参数与旧 cursor 按新契约区分', async ({ page }) => {
  const before = await sourceRequests(page);
  const archive = await archiveDocument(page);
  expect(archive.local_reply_count).toBe(25);

  // 省略 sort 与 sort=time 是同一页：既有调用方不受影响。
  const omitted = await pageOf(page, 1);
  expect(ids(omitted)).toEqual(timeFirstPage);
  expect(await pageOf(page, 1, 'time')).toEqual(omitted);

  // 热度第 1 页是时间序第 3 页的尾部：排序发生在完整集合上，不是重排当前页。
  const hot = await pageOf(page, 1, 'hot');
  expect(ids(hot)).toEqual(hotFirstPage);
  expect(hot.items.map(item => item.like_count)).toEqual([24, 23, 22, 21, 20, 19, 18, 17, 16, 15]);
  expect(hot.count).toBe(omitted.count);
  const timeThirdPage = await pageOf(page, 3);
  expect(ids(timeThirdPage)).toEqual(
    Array.from({ length: 5 }, (_value, index) => String(960000 + 21 + index)));
  expect(ids(await pageOf(page, 3, 'hot'))).toEqual(['960005', '960004', '960003', '960002', '960001']);
  // 越界页是成功空页并带实际总数，与既有末页收敛规则一致。
  const beyond = await pageOf(page, 9, 'hot');
  expect(beyond.items).toEqual([]);
  expect(beyond.count).toBe(25);

  // 参数校验按新契约区分：非法排序、只有 cursor 的模式带 sort、重复参数都是 422。
  for (const query of [
    'page=1&sort=latest', 'page=1&sort=HOT', 'page=1&sort=', 'sort=hot', 'sort=time',
    'limit=3&sort=time', 'page=1&sort=hot&sort=time', 'page=1&sort=hot&limit=3',
  ]) {
    expect((await page.request.get(`${repliesPath}?${query}`)).status(), query).toBe(422);
  }

  // 旧时间序 token 仍有效且保持冻结：热度读取不新建或改写 cursor 资源。
  const preview = await (await page.request.get(`${repliesPath}?limit=3`)).json();
  const token = preview.next_cursor as string;
  expect(token).toBeTruthy();
  const frozen = await (await page.request.get(`${repliesPath}?cursor=${token}&limit=10`)).json();
  expect(frozen.items.map((item: { id: string }) => item.id))
    .toEqual(Array.from({ length: 10 }, (_value, index) => String(960000 + 4 + index)));
  expect((await page.request.get(`${repliesPath}?cursor=${token}&limit=10&sort=hot`)).status()).toBe(422);
  expect((await page.request.get(`${repliesPath}?cursor=${token}&limit=10&sort=time`)).status()).toBe(422);
  await pageOf(page, 1, 'hot');
  await pageOf(page, 2, 'hot');
  expect(await (await page.request.get(`${repliesPath}?cursor=${token}&limit=10`)).json()).toEqual(frozen);

  // 通知定位保持时间序页码，不接受排序参数；会话内容也不因热度读取改变。
  const located = await (await page.request.get(`${repliesPath}/${locatedId}/location`)).json();
  expect(located.page).toBe(3);
  expect(located.items.map((item: { id: string }) => item.id)).toEqual(ids(timeThirdPage));
  expect((await page.request.get(`${repliesPath}/${locatedId}/location?sort=hot`)).status()).toBe(422);
  // 会话整段一次返回 11 条（13 票起的读取契约），顺序仍是时间正序、与排序无关。
  const conversation = await (await page.request.get(`${repliesPath}/960002/conversation`)).json();
  expect(conversation.items.map((item: { id: string }) => item.id)).toEqual([
    '960002', '960003', '960004',
    ...Array.from({ length: 8 }, (_value, index) => String(960013 + index))]);
  expect((await page.request.get(`${repliesPath}/960002/conversation?sort=hot`)).status()).toBe(422);

  // 只读：不请求上游、不改归档。
  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page)).toEqual(archive);
});

test('手机回复详情：默认 ☰ 按时间，点击切到热度回第 1 页并显示后续页的高赞回复', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  const archive = await archiveDocument(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}`);

  const list = page.getByRole('list', { name: '相关回复' });
  await expect(list.locator('> li')).toHaveCount(10);
  const sort = page.getByRole('button', { name: '当前按时间，点击切换为按热度' });
  await expect(sort).toBeVisible();
  await expect(sort).toContainText('☰');
  await expect(sort).toContainText('按时间');
  // 回复数量与排序同为 13px，点击区不小于 44px（设计 §4／§6）。
  expect(await sort.evaluate(element => getComputedStyle(element).fontSize)).toBe('13px');
  expect((await sort.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  const heading = page.getByRole('heading', { name: '相关回复共25条' });
  expect(await heading.evaluate(element => getComputedStyle(element).fontSize)).toBe('13px');

  // 时间序旧到新：第 1 页是最早的 10 条，点赞最高的回复还不在这一页。
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${firstTimeId}"]`)).toHaveAttribute(
    'data-reading-id', `reply:${rootId}:${firstTimeId}`);
  await expect(list.locator('> li').first()).toHaveAttribute(
    'data-reading-id', `reply:${rootId}:${firstTimeId}`);
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${topLikedId}"]`)).toHaveCount(0);

  // 切到热度：回到第 1 页，最高赞回复（时间序第 3 页）出现在最前面。
  await sort.click();
  await expect(page.getByRole('button', { name: '当前按热度，点击切换为按时间' })).toContainText('按热度');
  await expect(list.locator('> li')).toHaveCount(10);
  await expect(list.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:${topLikedId}`);
  const rendered = await list.locator('> li').evaluateAll(items =>
    items.map(item => item.getAttribute('data-reading-id')));
  expect(rendered).toEqual(hotFirstPage.map(id => `reply:${rootId}:${id}`));
  const pager = page.getByRole('navigation', { name: '回复分页' });
  await expect(pager.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
  await expect(pager.getByRole('button', { name: '3' })).toBeVisible();
  // 翻到热度第 2 页仍是同一套排序，不回时间序。
  await pager.getByRole('button', { name: '下一页' }).click();
  await expect(list.locator('> li').first()).toHaveAttribute(
    'data-reading-id', `reply:${rootId}:${String(960000 + 15)}`);

  // 再点一次切回时间序第 1 页。
  await page.getByRole('button', { name: '当前按热度，点击切换为按时间' }).click();
  await expect(page.getByRole('button', { name: '当前按时间，点击切换为按热度' })).toContainText('按时间');
  await expect(list.locator('> li').first()).toHaveAttribute(
    'data-reading-id', `reply:${rootId}:${firstTimeId}`);

  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page)).toEqual(archive);
});

test('通知定位页仍是时间序：排序控件显示按时间，不受热度排序影响', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}/replies/${locatedId}/locate`);

  await expect(page.getByRole('button', { name: '当前按时间，点击切换为按热度' })).toBeVisible();
  const target = page.locator(`[data-reading-id="reply:${rootId}:${locatedId}"]`);
  await expect(target).toHaveAttribute('data-located', 'true');
  await expect(page.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '3' }))
    .toHaveAttribute('aria-current', 'page');
  expect(await sourceRequests(page)).toEqual(before);
});
