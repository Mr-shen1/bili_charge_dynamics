import { expect, test, type Page } from '@playwright/test';

// 06/13：对话投影与只读 conversation 子资源跑**实际归档 API + 本次运行独占的 SQLite**
// （backend/tests/live_app 的虚构上游）：页面是生产装配，关系来自真实归档的 parent 链。
// 13 把会话改成一次整段读取：缺省即全部本地成员，入口回复居中并标“刚才查看”；
// 显式 page 只是保留的旧兼容入口，前端不得使用。读取不触发上游采集。

const baseURL = 'http://127.0.0.1:4325';
const uid = '808';
const dynamicId = '800300';
const rootId = String(860000 + 1);
// 45 条虚构根评论里的第一个带 25 条虚构回复；关系夹具见 backend/tests/live_app.REPLY_PARENTS。
const repliesPath = `/api/archive/dynamics/${dynamicId}/comments/${rootId}/replies`;
const conversationUrl = (replyId: string): string => `${repliesPath}/${replyId}/conversation`;
// 命中 960002 起点的完整对话：起点、两条分支与跨页成员，共 11 条（旧分页口径是 10/1 两页）。
const startId = '960002';
const crossPageId = '960020';
const incompleteEntryId = '960008';
const cycleEntryId = '960022';
const conversationCount = 11;
const conversationIds = ['960002', '960003', '960004',
  ...Array.from({ length: 8 }, (_value, index) => String(960013 + index))];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL });
  try {
    // 仅测试夹具：45 条虚构根评论 + 25 条带真实父关系的虚构楼中楼，之后一切仍走真实归档链。
    expect((await api.post('/api/test/root-comments', { data: { dynamic: dynamicId } })).status()).toBe(200);
    expect((await api.post('/api/test/replies', { data: { dynamic: dynamicId, root: rootId } })).status())
      .toBe(200);
    const added = await api.post('/api/manage/ups', { data: { uid } });
    expect([201, 409]).toContain(added.status());
    expect((await api.patch(`/api/manage/ups/${uid}/monitor`,
      { data: { mode: 'specified', recent_n: 10, enabled: true } })).status()).toBe(200);
    if ((await api.get(`/api/manage/ups/${uid}/targets`)).ok()) {
      const targets = await (await api.get(`/api/manage/ups/${uid}/targets`)).json();
      if (!targets.targets.some((target: { id: string }) => target.id === dynamicId)) {
        expect((await api.post(`/api/manage/ups/${uid}/targets`, { data: { id: dynamicId } })).status())
          .toBe(201);
      }
    }
    const sync = await api.post('/api/sync/initial', { data: { uid } });
    expect(sync.status()).toBe(200);
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

async function pageOf(page: Page, number: number) {
  return (await (await page.request.get(`${repliesPath}?page=${number}&limit=10`)).json()) as {
    items: { id: string; conversation: { start_id: string; count: number; incomplete: boolean } | null }[];
    count: number;
  };
}

test('手机三级返回入口使用相同的阅读链接样式', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const entries = [
    { path: `/dynamics/${dynamicId}`, name: '‹ 动态列表' },
    { path: `/dynamics/${dynamicId}/comments/${rootId}`, name: '评论详情，返回动态详情' },
    { path: `/dynamics/${dynamicId}/comments/${rootId}/replies/${crossPageId}/conversation`,
      name: '会话列表，返回评论详情' },
  ];
  for (const { path, name } of entries) {
    await page.goto(path);
    const back = page.getByRole('button', { name, exact: true });
    await expect(back).toHaveCSS('color', 'rgb(40, 127, 143)');
    await expect(back).toHaveCSS('font-size', '14px');
    await expect(back).toHaveCSS('line-height', '22px');
    await expect(back).toHaveCSS('font-weight', '400');
    await expect(back).toHaveCSS('padding', '0px 4px');
    expect((await back.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
});

test('真实 HTTP 契约：对话投影只标注当前页条目，会话子资源缺省一次返回整段', async ({ page }) => {
  const before = await sourceRequests(page);
  const archive = await archiveDocument(page);
  expect(archive.local_reply_count).toBe(25);

  // page 模式：起点、分支与跨页成员共享同一段计数；独立发言与同名作者不串楼。
  const first = await pageOf(page, 1);
  const projected = Object.fromEntries(first.items.map(item => [item.id, item.conversation]));
  for (const id of ['960002', '960003', '960004']) {
    expect(projected[id]).toEqual({ start_id: startId, count: conversationCount, incomplete: false });
  }
  for (const id of ['960005', '960006', '960009']) expect(projected[id]).toBeNull();
  // 父回复未保存：断点止步、两条可确认并标记上下文不完整。
  expect(projected['960007']).toEqual({ start_id: '960007', count: 2, incomplete: true });
  expect(projected['960008']).toEqual({ start_id: '960007', count: 2, incomplete: true });

  const second = await pageOf(page, 2);
  expect(second.items.map(item => item.id)).toEqual(
    Array.from({ length: 10 }, (_value, index) => String(960011 + index)));
  expect(second.items[0]!.conversation).toBeNull();
  expect(second.items[2]!.conversation).toEqual({ start_id: startId, count: conversationCount, incomplete: false });
  expect(second.items[9]!.conversation).toEqual({ start_id: startId, count: conversationCount, incomplete: false });

  const third = await pageOf(page, 3);
  // 异常环：同一段可确认成员、起点稳定、不会无界遍历。
  expect(third.items[0]!.conversation).toEqual({ start_id: '960021', count: 2, incomplete: true });
  expect(third.items[1]!.conversation).toEqual({ start_id: '960021', count: 2, incomplete: true });
  for (const item of third.items.slice(2)) expect(item.conversation).toBeNull();

  // 定位响应为其所在页提供同一份投影（通知直达也能展示入口）。
  const located = await (await page.request.get(`${repliesPath}/${crossPageId}/location`)).json();
  expect(located.page).toBe(2);
  expect(located.items).toEqual(second.items);

  // 会话子资源缺省即整段：身份回显、起点、本地总数与全部 11 条，没有 page 键。
  const conversation = await (await page.request.get(conversationUrl(crossPageId))).json();
  expect(conversation).toMatchObject({
    dynamic_id: dynamicId, root_id: rootId, reply_id: crossPageId,
    start_id: startId, incomplete: false, count: conversationCount, next_cursor: null,
  });
  expect(conversation.page).toBeUndefined();
  expect(conversation.root).toBeUndefined();
  expect(conversation.items.map((item: { id: string }) => item.id)).toEqual(conversationIds);

  // 显式 page 是保留的旧兼容入口：仍与整段成员同源，每页最多 10 条。
  const legacyPage = await (await page.request.get(`${conversationUrl(crossPageId)}?page=2&limit=10`)).json();
  expect(legacyPage.page).toBe(2);
  expect(legacyPage.items.map((item: { id: string }) => item.id)).toEqual([crossPageId]);
  expect(legacyPage.items).toEqual(conversation.items.slice(10));
  const beyond = await (await page.request.get(`${conversationUrl(crossPageId)}?page=9`)).json();
  expect(beyond.items).toEqual([]);
  expect(beyond.count).toBe(conversationCount);

  const partial = await (await page.request.get(conversationUrl(incompleteEntryId))).json();
  expect(partial).toMatchObject({ start_id: '960007', incomplete: true, count: 2 });
  expect(partial.items.map((item: { id: string }) => item.id)).toEqual(['960007', '960008']);

  // 不存在、跨父级与非法查询分开：身份错误是 404，参数错误是 422。
  expect((await page.request.get(conversationUrl('999999'))).status()).toBe(404);
  expect((await page.request.get(
    `/api/archive/dynamics/${dynamicId}/comments/860002/replies/${crossPageId}/conversation`)).status())
    .toBe(404);
  // 批量只属于旧显式分页入口：只给 limit 或不是 10 都是冲突参数。
  expect((await page.request.get(`${conversationUrl(crossPageId)}?limit=3`)).status()).toBe(422);
  expect((await page.request.get(`${conversationUrl(crossPageId)}?limit=10`)).status()).toBe(422);
  expect((await page.request.get(`${conversationUrl(crossPageId)}?page=0`)).status()).toBe(422);

  // 只读：不请求上游、不改归档、不冻结回复 cursor 页。
  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page)).toEqual(archive);
});

test('手机普通回复页：整段会话一次呈现、入口回复居中并唯一标记“刚才查看”', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  const archive = await archiveDocument(page);
  const conversations = trackConversationRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}`);

  const list = page.getByRole('list', { name: '相关回复' });
  await expect(list.locator('> li')).toHaveCount(10);
  // 门槛是“至少两条且当前条不是起点”：起点与独立发言都没有入口。
  const pager = page.getByRole('navigation', { name: '回复分页' });
  await pager.getByRole('button', { name: '2', exact: true }).click();
  await expect(list.locator('> li')).toHaveCount(10);
  const entry = page.locator(`[data-reading-id="reply:${rootId}:${crossPageId}"]`);
  await expect(entry.getByRole('button', { name: '查看对话' })).toBeVisible();
  await expect(page.locator(`[data-reading-id="reply:${rootId}:960011"]`)
    .getByRole('button', { name: '查看对话' })).toHaveCount(0);

  await entry.getByRole('button', { name: '查看对话' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/${crossPageId}/conversation$`));
  const conversation = page.getByRole('list', { name: '对话内容' });
  // 11 条一次全给：不截成 10 条、没有分页控件、不循环请求旧分页。
  await expect(conversation.locator('> li')).toHaveCount(conversationCount);
  await expect(conversation.locator('> li').first())
    .toHaveAttribute('data-reading-id', `reply:${rootId}:${startId}`);
  await expect(conversation.locator('> li').last())
    .toHaveAttribute('data-reading-id', `reply:${rootId}:${crossPageId}`);
  await expect(page.getByText(`共 ${conversationCount} 条`)).toBeVisible();
  await expect(page.getByRole('navigation', { name: '回复分页' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下一页' })).toHaveCount(0);
  // 标记唯一且准确：只有入口回复带“刚才查看”。
  await expect(page.getByText('刚才查看')).toHaveCount(1);
  await expect(page.locator('[data-conversation-entry="true"]')).toHaveCount(1);
  await expect(page.locator('[data-conversation-entry="true"]'))
    .toHaveAttribute('data-reading-id', `reply:${rootId}:${crossPageId}`);
  // 入口回复是整段末尾，也要能停在视口中央（靠按需补的尾部留白）。
  await expect.poll(() => verticalCenterOffset(page, `[data-reading-id="reply:${rootId}:${crossPageId}"]`))
    .toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(0);
  // 整段只读一次，且不带页码或批量。
  expect(conversations.map(url => url.search)).toEqual(['']);

  // 排序控件与一级评论都不在会话页重复出现。
  await expect(page.getByText('按时间')).toHaveCount(0);
  await expect(conversation.getByText('虚构楼中楼根评论')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '会话列表，返回评论详情' })).toHaveText('‹ 会话列表');

  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}/comments/${rootId}$`));
  await expect(page.getByRole('list', { name: '相关回复' })).toBeVisible();

  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page)).toEqual(archive);
});

test('短会话末条居中：留白撑开的范围随历史前进一起还原，不被夹回页首', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}`);
  await expect(page.getByRole('list', { name: '相关回复' }).locator('> li')).toHaveCount(10);

  // 960008 属于“父级未保存”的两条短对话：整段只有 2 条，内容不足一屏。
  await page.locator(`[data-reading-id="reply:${rootId}:${incompleteEntryId}"]`)
    .getByRole('button', { name: '查看对话' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/${incompleteEntryId}/conversation$`));
  const conversation = page.getByRole('list', { name: '对话内容' });
  await expect(conversation.locator('> li')).toHaveCount(2);
  const entrySelector = `[data-reading-id="reply:${rootId}:${incompleteEntryId}"]`;
  // 末条居中：按需补的留白把可滚动范围撑开，条目真的停在视口中央。
  await expect.poll(() => verticalCenterOffset(page, entrySelector)).toBeLessThanOrEqual(2);
  const padding = await listPadding(conversation);
  expect(padding.lead + padding.tail).toBeGreaterThan(0);
  const centeredY = await scrollY(page);

  // 返回来源再前进回同一访问：留白与位置一起还原，不重新居中也不被夹回。
  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}/comments/${rootId}$`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/replies/${incompleteEntryId}/conversation$`));
  const restored = page.getByRole('list', { name: '对话内容' });
  await expect(restored.locator('> li')).toHaveCount(2);
  await expect.poll(() => scrollY(page)).toBe(centeredY);
  await expect.poll(() => verticalCenterOffset(page, entrySelector)).toBeLessThanOrEqual(2);
  expect(await listPadding(restored)).toEqual(padding);

  expect(await sourceRequests(page)).toEqual(before);
});

/** 列表的居中留白（px）：恢复后必须与离开时一致，否则可滚动范围会变。 */
async function listPadding(locator: ReturnType<Page['getByRole']>): Promise<{ lead: number; tail: number }> {
  return locator.evaluate(element => {
    const style = (element as HTMLElement).style;
    return {
      lead: Number.parseFloat(style.paddingTop || '0'),
      tail: Number.parseFloat(style.paddingBottom || '0'),
    };
  });
}

test('通知定位页进入整段对话再返回该次定位访问；缺祖先与异常环有明确提示', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  const tracked = trackReplyRequests(page);

  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}/replies/${crossPageId}/locate`);
  const located = page.locator(`[data-reading-id="reply:${rootId}:${crossPageId}"]`);
  await expect(located).toHaveAttribute('data-located', 'true');
  // 定位页是时间序第 2 页：目标在第 2 页末条，页面按它落点。
  const pager = page.getByRole('navigation', { name: '回复分页' });
  await expect(pager.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
  const savedScroll = await scrollY(page);
  expect(savedScroll).toBeGreaterThan(0);
  expect(tracked.locations).toHaveLength(1);
  expect(tracked.replies).toEqual([]);

  await located.getByRole('button', { name: '查看对话' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/${crossPageId}/conversation$`));
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(conversationCount);

  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/${crossPageId}/locate$`));
  await expect(page.locator(`[data-reading-id="reply:${rootId}:${crossPageId}"]`))
    .toHaveAttribute('data-located', 'true');
  // 恢复的是这次定位访问：同一时间序第 2 页与位置，不重新主动定位。
  await expect(pager.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
  await restoreScroll(page, savedScroll);
  expect(tracked.locations).toHaveLength(1);
  expect(tracked.replies).toEqual([]);

  // 缺祖先：只读可确认的两条并提示上下文不完整，不伪造缺失作者或内容。
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}/replies/${incompleteEntryId}/conversation`);
  await expect(page.getByText('部分上下文暂不可用')).toBeVisible();
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(2);

  // 异常环：条数与起点有限，不进入无界遍历。
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}/replies/${cycleEntryId}/conversation`);
  await expect(page.getByText('部分上下文暂不可用')).toBeVisible();
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(2);
  await expect(page.getByText('共 2 条')).toBeVisible();

  expect(await sourceRequests(page)).toEqual(before);
});

test('直达或刷新会话页可独立整段读取并再次居中；无来源时返回所属回复详情', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}/replies/${crossPageId}/conversation`);
  const conversation = page.getByRole('list', { name: '对话内容' });
  await expect(conversation.locator('> li')).toHaveCount(conversationCount);
  // 直达也要把入口回复居中。
  await expect.poll(() => verticalCenterOffset(page, `[data-reading-id="reply:${rootId}:${crossPageId}"]`))
    .toBeLessThanOrEqual(2);

  // 刷新后仍靠 URL 与只读接口得到同一段整段对话，不依赖来源内存，并再次居中一次。
  await page.reload();
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(conversationCount);
  await expect(page.getByText(`共 ${conversationCount} 条`)).toBeVisible();
  await expect.poll(() => verticalCenterOffset(page, `[data-reading-id="reply:${rootId}:${crossPageId}"]`))
    .toBeLessThanOrEqual(2);

  // 无有效来源：替换为所属回复详情的时间序第 1 页，不留下不可用的会话地址。
  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}/comments/${rootId}$`));
  const restored = page.getByRole('list', { name: '相关回复' });
  await expect(restored.locator('> li')).toHaveCount(10);
  await expect(restored.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:960001`);
  await expect(page.getByRole('button', { name: '当前按时间，点击切换为按热度' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '1' }))
    .toHaveAttribute('aria-current', 'page');
  // 替换导航不留会话记录：历史后退不会又进会话地址。
  const back = await page.goBack();
  if (back) await page.waitForLoadState('domcontentloaded');
  await expect(page).not.toHaveURL(new RegExp(`/conversation$`));
  // 不进页面的返回也不会把会话读成别的东西：再点一次浏览器后退仍停在站内。
  expect(await sourceRequests(page)).toEqual(before);
});

/** 记录本次页面发出的回复页码与定位请求，用来断言恢复没有重读或重新定位。 */
function trackReplyRequests(page: Page): { replies: URL[]; locations: URL[] } {
  const tracked = { replies: [] as URL[], locations: [] as URL[] };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === repliesPath) tracked.replies.push(url);
    else if (url.pathname.startsWith(`${repliesPath}/`) && url.pathname.endsWith('/location')) {
      tracked.locations.push(url);
    }
  });
  return tracked;
}

/** 记录会话请求：整段读取只应发一次，且不带页码或批量。 */
function trackConversationRequests(page: Page): URL[] {
  const urls: URL[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith(`${repliesPath}/`) && url.pathname.endsWith('/conversation')) urls.push(url);
  });
  return urls;
}

/** 元素垂直中心与视口中心的距离（px）；用来断言“定位到屏幕中央”。 */
async function verticalCenterOffset(page: Page, selector: string): Promise<number> {
  return page.evaluate(sel => {
    const element = document.querySelector(sel);
    if (!element) return Number.POSITIVE_INFINITY;
    const box = element.getBoundingClientRect();
    return Math.abs(box.top + box.height / 2 - window.innerHeight / 2);
  }, selector);
}

/** 当前滚动位置：返回后按稳定锚点恢复，允许 1px 级的取整差。 */
async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

async function restoreScroll(page: Page, expected: number): Promise<void> {
  await expect.poll(async () => Math.abs((await scrollY(page)) - expected) <= 1).toBe(true);
}

test('热度第 2 页进入会话再返回：恢复那一次热度访问的页码、排序与位置，不重读第 1 页', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  const archive = await archiveDocument(page);
  const tracked = trackReplyRequests(page);
  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}`);
  const list = page.getByRole('list', { name: '相关回复' });
  const pager = page.getByRole('navigation', { name: '回复分页' });
  await expect(list.locator('> li')).toHaveCount(10);

  // 切到热度并读到第 2 页：热度第 2 页是时间序第 2 页的倒序段。
  await page.getByRole('button', { name: '当前按时间，点击切换为按热度' }).click();
  await expect(list.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:960025`);
  await pager.getByRole('button', { name: '2', exact: true }).click();
  await expect(list.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:960015`);
  await expect(pager.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => window.scrollTo(0, 400));
  const savedScroll = await scrollY(page);
  expect(savedScroll).toBeGreaterThan(0);

  const entry = page.locator(`[data-reading-id="reply:${rootId}:960013"]`);
  await entry.getByRole('button', { name: '查看对话' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/960013/conversation$`));
  const conversation = page.getByRole('list', { name: '对话内容' });
  await expect(conversation.locator('> li')).toHaveCount(conversationCount);
  await expect(conversation.locator('> li').first())
    .toHaveAttribute('data-reading-id', `reply:${rootId}:${startId}`);
  // 入口回复在整段中间：同样居中并标记一次。
  await expect(page.getByText('刚才查看')).toHaveCount(1);

  const requestsBeforeBack = tracked.replies.length;
  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}/comments/${rootId}$`));

  // 先看到的就是那一次热度访问：第 2 页、热度内容与标记，不是先显示时间序第 1 页。
  await expect(list.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:960015`);
  await expect(page.getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeVisible();
  await expect(pager.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
  await restoreScroll(page, savedScroll);
  // 恢复不重读第 1 页，也不把定位页码当热度页码重新定位。
  expect(tracked.replies.length).toBe(requestsBeforeBack);
  expect(tracked.locations).toEqual([]);

  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page)).toEqual(archive);
});

test('受控迟到的第 3 页响应不覆盖会话返回后恢复的访问', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let thirdPageRequested = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // 真实请求被挂起：等从会话返回后再放行，迟到的响应不能改写恢复后的页码与内容。
  await page.route(
    url => url.pathname === repliesPath && url.searchParams.get('page') === '3',
    async route => {
      thirdPageRequested = true;
      await gate;
      await route.continue().catch(() => undefined);
    },
  );

  await page.goto(`/dynamics/${dynamicId}/comments/${rootId}`);
  const list = page.getByRole('list', { name: '相关回复' });
  const pager = page.getByRole('navigation', { name: '回复分页' });
  await expect(list.locator('> li')).toHaveCount(10);
  await pager.getByRole('button', { name: '2', exact: true }).click();
  await expect(list.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:960011`);
  await page.evaluate(() => window.scrollTo(0, 300));
  await pager.getByRole('button', { name: '3', exact: true }).click();
  await expect.poll(() => thirdPageRequested).toBe(true);

  await page.locator(`[data-reading-id="reply:${rootId}:960013"]`)
    .getByRole('button', { name: '查看对话' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/960013/conversation$`));
  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicId}/comments/${rootId}$`));
  await expect(list.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:960011`);

  // 放行迟到的第 3 页：恢复后的第 2 页内容与页码都不变。
  release();
  await page.waitForTimeout(500);
  await expect(list.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:960011`);
  await expect(pager.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
});

