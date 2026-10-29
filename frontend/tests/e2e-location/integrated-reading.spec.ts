import { expect, test, type Locator, type Page } from '@playwright/test';

// 09：阅读改版组合回归——同一候选、同一隔离 SQLite、同一生产前端装配。
// 单票证据已分别取证；这里把 01/03/04/05/06/07 的行为串成真实使用路径，
// 页面仍是生产装配，读取全走实际归档 API（backend/tests/live_app 的虚构上游），
// 只替换来源 HTTP 与（受控竞态时的）网络时序。桌面与窄屏用 640px 分支切换，不新增平行装配。

const baseURL = 'http://127.0.0.1:4325';
const uidA = '808';
const uidB = '202';
const uidC = '707';
// A：45 条一级评论、首个根评论 25 条回复；B：12 条一级评论、首个根评论同样 25 条回复。
// 两条归档各有自己的评论条数与回复页码，用来证明卡片之间不共用状态。
const dynamicA = '800300';
const dynamicB = '9007199254740993123';
// C：45 条一级评论，只有第 2 批的 860030 带回复——用于通知锚点→楼中楼→对话，
// 又不把额外的回复挂到 A/B 的归档上（其它隔离用例按各自归档计数断言）。
const dynamicC = '900707';
const rootId = String(860000 + 1);
const timeFirstId = '960001';
const hotFirstId = '960025';
const hotSecondPageFirst = '960015';
const conversationEntry = '960013';
// 第 2 批（时间序第 25…44 条）里的另一楼：通知锚点与楼中楼/对话组合使用。
const laterRoot = '860030';
const conversationCount = 11;
const commentsPath = `/api/archive/dynamics/${dynamicA}/comments`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL });
  try {
    // 仅测试夹具：两条归档各自启用虚构评论与楼中楼，之后一切写入仍走真实归档链。
    expect((await api.post('/api/test/root-comments', { data: { dynamic: dynamicA } })).status()).toBe(200);
    expect((await api.post('/api/test/root-comments', { data: { dynamic: dynamicB, size: 12 } })).status())
      .toBe(200);
    for (const dynamic of [dynamicA, dynamicB]) {
      expect((await api.post('/api/test/replies', { data: { dynamic, root: rootId } })).status()).toBe(200);
    }
    // 第三条归档：通知锚点落在第 2 批的 860030，该楼另带 25 条回复，可进入楼中楼与对话。
    expect((await api.post('/api/test/root-comments', { data: { dynamic: dynamicC } })).status()).toBe(200);
    expect((await api.post('/api/test/replies', { data: { dynamic: dynamicC, root: laterRoot } })).status())
      .toBe(200);
    for (const [uid, dynamic] of [[uidA, dynamicA], [uidB, dynamicB], [uidC, dynamicC]] as const) {
      const added = await api.post('/api/manage/ups', { data: { uid } });
      expect([201, 409]).toContain(added.status());
      expect((await api.patch(`/api/manage/ups/${uid}/monitor`,
        { data: { mode: 'specified', recent_n: 10, enabled: true } })).status()).toBe(200);
      expect((await api.post(`/api/manage/ups/${uid}/targets`, { data: { id: dynamic } })).status()).toBe(201);
      const sync = await api.post('/api/sync/initial', { data: { uid } });
      expect(sync.status()).toBe(200);
      expect(await sync.json()).toMatchObject({ processed: 1, succeeded: 1 });
    }
  } finally {
    await api.dispose();
  }
});

async function sourceRequests(page: Page): Promise<Record<string, number>> {
  return (await (await page.request.get('/api/test/source-requests')).json()) as Record<string, number>;
}

async function archiveDocument(page: Page, dynamic: string): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/archive/dynamics/${dynamic}`)).json()) as Record<string, unknown>;
}

function card(page: Page, dynamic: string): Locator {
  return page.locator(`[data-reading-id="${dynamic}"]`);
}

function region(page: Page, dynamic: string): Locator {
  return card(page, dynamic).getByRole('region', { name: '评论区' });
}

/** 只数一级评论：嵌套回复也是 listitem。 */
function roots(area: Locator): Locator {
  return area.locator('[aria-label="一级评论"] > li');
}

function sortButton(area: Locator, current: 'time' | 'hot'): Locator {
  return area.getByRole('button', {
    name: current === 'time' ? '当前按时间，点击切换为按热度' : '当前按热度，点击切换为按时间',
  });
}

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY));
}

test('桌面组合：两卡各自排序与回复页，正文新标签 opener 为空且原列表状态不动', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(3);
  const before = await sourceRequests(page);
  const archiveA = await archiveDocument(page, dynamicA);
  const archiveB = await archiveDocument(page, dynamicB);

  // 两张卡片各自展开一级评论：条数来自各自归档，不互相串批次。
  await card(page, dynamicA).getByRole('button', { name: '来源评论 45' }).click();
  await card(page, dynamicB).getByRole('button', { name: '来源评论 12' }).click();
  await expect(roots(region(page, dynamicA))).toHaveCount(20);
  await expect(roots(region(page, dynamicB))).toHaveCount(12);
  await expect(sortButton(region(page, dynamicA), 'time')).toBeVisible();
  await expect(sortButton(region(page, dynamicB), 'time')).toBeVisible();

  // A 切到热度并追加下一批；B 仍是自己的 12 条与按时间，没有“加载更多”。
  await sortButton(region(page, dynamicA), 'time').click();
  await expect(sortButton(region(page, dynamicA), 'hot')).toBeVisible();
  await expect(region(page, dynamicB).getByRole('button', { name: '加载更多评论' })).toHaveCount(0);
  await region(page, dynamicA).getByRole('button', { name: '加载更多评论' }).click();
  await expect(roots(region(page, dynamicA))).toHaveCount(40);
  await expect(roots(region(page, dynamicB))).toHaveCount(12);

  // 受控迟到：A 的第二批请求被挂起，用户已经切换排序；迟到的成功不得覆盖最后一次选择。
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  // 同一个函数既作 route 判定也作 unroute 依据：只挂起带 cursor 的后续批。
  const cursorOnly = (url: URL) => url.pathname === commentsPath && url.searchParams.get('cursor') !== null;
  await page.route(cursorOnly, async route => {
    held = true;
    await gate;
    await route.continue().catch(() => undefined);
  });
  await region(page, dynamicA).getByRole('button', { name: '加载更多评论' }).click();
  await expect.poll(() => held).toBe(true);
  await sortButton(region(page, dynamicA), 'hot').click();
  await expect(sortButton(region(page, dynamicA), 'time')).toBeVisible();
  await expect(roots(region(page, dynamicA))).toHaveCount(20);
  release();
  await page.waitForTimeout(300);
  await expect(roots(region(page, dynamicA))).toHaveCount(20);
  await expect(sortButton(region(page, dynamicA), 'time')).toBeVisible();
  await expect(roots(region(page, dynamicB))).toHaveCount(12);
  await page.unroute(cursorOnly);

  // 回复页码各自独立：A 的楼主回复展开并翻到第 2 页，B 保持未展开的 3 条预览。
  // 一级评论切换排序会重置该区的回复展开，因此在这之后才做回复翻页。
  const rootA = roots(region(page, dynamicA)).first();
  await rootA.getByRole('button', { name: '展开回复' }).click();
  await expect(rootA.getByRole('list', { name: '回复列表' }).getByRole('listitem')).toHaveCount(10);
  await rootA.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '2' }).click();
  await expect(rootA.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '2' }))
    .toHaveAttribute('aria-current', 'page');
  const rootB = roots(region(page, dynamicB)).first();
  await expect(rootB.getByRole('list', { name: '回复列表' }).getByRole('listitem')).toHaveCount(3);
  await expect(rootB.getByRole('navigation', { name: '回复分页' })).toHaveCount(0);

  // 把 B 带到视口里并滚到非零位置，然后从卡片正文打开新标签。
  await card(page, dynamicB).evaluate(element => {
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 100);
  });
  const savedScroll = await scrollY(page);
  expect(savedScroll).toBeGreaterThan(0);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: `阅读全文 ${dynamicB}` }).click({ position: { x: 8, y: 8 } }),
  ]);
  await expect(popup).toHaveURL(new RegExp(`/dynamics/${dynamicB}$`));
  await expect(popup).toHaveTitle('动态详情');
  // 独立标签：没有 opener 依赖，也不复制原标签的内存状态。
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await expect(popup.locator('.detail-card')).toContainText(`虚构正文 ${dynamicB}`);
  await expect(popup.getByRole('region', { name: '评论区' })).toBeVisible();
  await popup.reload();
  await expect(popup.locator('.detail-card')).toContainText(`虚构正文 ${dynamicB}`);
  await popup.close();

  // 原列表：URL、滚动与两张卡片的排序/批次/回复页码都留在原地。
  await expect(page).toHaveURL(/\/$/);
  expect(await scrollY(page)).toBe(savedScroll);
  await expect(sortButton(region(page, dynamicA), 'time')).toBeVisible();
  await expect(roots(region(page, dynamicA))).toHaveCount(20);
  await expect(roots(region(page, dynamicB))).toHaveCount(12);
  await expect(rootA.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '2' }))
    .toHaveAttribute('aria-current', 'page');

  // scope 切换：单 UP 只留自己的卡片；回到全部动态仍是三条归档，内联面板按新访问收起。
  await page.getByRole('link', { name: '虚构晨光' }).click();
  await expect(page).toHaveURL(`/ups/${uidB}`);
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(region(page, dynamicA)).toHaveCount(0);
  await expect(region(page, dynamicB)).toHaveCount(0);
  await page.getByRole('link', { name: '全部动态' }).click();
  await expect(page.getByRole('article')).toHaveCount(3);

  // 只读：整段组合没有触发采集，也没有改动归档内容。
  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page, dynamicA)).toEqual(archiveA);
  expect(await archiveDocument(page, dynamicB)).toEqual(archiveB);
});

test('手机组合：列表→详情→楼中楼热度后续页→跨页对话→原访问恢复→回列表', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  const archiveA = await archiveDocument(page, dynamicA);
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(3);
  // 先把列表滚离顶部：回到列表时位置要还原，而不是回到页首。
  await card(page, dynamicA).evaluate(element => {
    window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 40);
  });
  const listScroll = await scrollY(page);

  // 窄屏评论按钮进入详情并定位评论区（站内入口保持）。
  await card(page, dynamicA).getByRole('button', { name: '来源评论 45' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicA}$`));
  const detailComments = page.getByRole('region', { name: '评论区' });
  await expect(detailComments.getByRole('listitem').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '‹ 动态列表' })).toBeVisible();

  // 一级评论的 UP 回复预览进入独立楼中楼页。
  const root = page.locator(`[data-reading-id="comment:${rootId}"]`);
  await expect(root.getByRole('button', { name: '共25条回复' })).toBeVisible();
  await root.getByRole('button', { name: '共25条回复' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicA}/comments/${rootId}$`));
  const thread = page.getByRole('list', { name: '相关回复' });
  const pager = page.getByRole('navigation', { name: '回复分页' });
  await expect(thread.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:${timeFirstId}`);

  // 切到热度并读到后续页：热度对完整本地集合排序，第 2 页与时间序内容不同。
  await page.getByRole('button', { name: '当前按时间，点击切换为按热度' }).click();
  await expect(thread.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:${hotFirstId}`);
  await pager.getByRole('button', { name: '2', exact: true }).click();
  await expect(thread.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:${hotSecondPageFirst}`);
  await expect(pager.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => window.scrollTo(0, 320));
  const threadScroll = await scrollY(page);
  expect(threadScroll).toBeGreaterThan(0);

  // 该页条目进入完整跨页对话：整段 11 条一次呈现，入口回复居中并唯一标记“刚才查看”。
  const entry = page.locator(`[data-reading-id="reply:${rootId}:${conversationEntry}"]`);
  await entry.getByRole('button', { name: '查看对话' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/${conversationEntry}/conversation$`));
  const conversation = page.getByRole('list', { name: '对话内容' });
  await expect(conversation.locator('> li')).toHaveCount(conversationCount);
  await expect(conversation.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:960002`);
  await expect(conversation.locator('> li').last()).toHaveAttribute('data-reading-id', `reply:${rootId}:960020`);
  await expect(page.getByText(`共 ${conversationCount} 条`)).toBeVisible();
  await expect(page.getByRole('button', { name: '会话列表，返回评论详情' })).toHaveText('‹ 会话列表');
  // 没有分页控件：整段一次读完，入口回复在整段中间也照样居中。
  await expect(page.getByRole('navigation', { name: '回复分页' })).toHaveCount(0);
  await expect(page.locator('[data-conversation-entry="true"]'))
    .toHaveAttribute('data-reading-id', `reply:${rootId}:${conversationEntry}`);
  await expect(page.getByText('刚才查看')).toHaveCount(1);

  // 返回来源：恢复那一次热度第 2 页访问，而不是时间序第 1 页。
  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicA}/comments/${rootId}$`));
  await expect(thread.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:${hotSecondPageFirst}`);
  await expect(page.getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeVisible();
  await expect(pager.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => Math.abs((await scrollY(page)) - threadScroll) <= 1).toBe(true);

  // 浏览器前进回会话、后退再回这一次回复访问：前进也按快照恢复排序与页码。
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`/replies/${conversationEntry}/conversation$`));
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(conversationCount);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicA}/comments/${rootId}$`));
  await expect(thread.locator('> li').first()).toHaveAttribute('data-reading-id', `reply:${rootId}:${hotSecondPageFirst}`);
  await expect(page.getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeVisible();

  // 回到详情：同一动态的详情访问被恢复（评论区仍在，不重新加载列表）。
  await page.getByRole('button', { name: '评论详情，返回动态详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicA}$`));
  await expect(page.getByRole('region', { name: '评论区' })).toBeVisible();
  // 再回到列表：scope 与滚动位置按列表访问还原。
  await page.getByRole('button', { name: '‹ 动态列表' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('article')).toHaveCount(3);
  await expect.poll(async () => Math.abs((await scrollY(page)) - listScroll) <= 2).toBe(true);
  await expect(page.getByRole('link', { name: '全部动态' })).toHaveAttribute('aria-current', 'page');

  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page, dynamicA)).toEqual(archiveA);
});

test('通知定位组合：第 N 页锚点→查看对话→返回原定位访问；直达与刷新无来源仍可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const before = await sourceRequests(page);
  const archiveC = await archiveDocument(page, dynamicC);

  // 一级评论后续批的锚点入口：定位到第 2 批的目标本身，并记住这次访问。
  const locatedRoot = laterRoot;
  await page.goto(`${baseURL}/dynamics/${dynamicC}/comments/${locatedRoot}/locate`);
  await expect(page.locator(`[data-reading-id="comment:${locatedRoot}"]`)).toHaveAttribute('data-located', 'true');
  const batch = page.getByRole('region', { name: '评论区' });
  // 定位窗口以目标开头：860030 是时间序第 30 条，后面只剩 15 条。
  await expect(batch.getByRole('listitem')).toHaveCount(16);
  await page.evaluate(() => window.scrollTo(0, 240));
  const locatedScroll = await scrollY(page);
  // 该批的楼主评论进入楼中楼，再从楼中楼进入对话，原路返回仍回到这次定位访问。
  await batch.locator(`[data-reading-id="comment:${laterRoot}"]`)
    .getByRole('button', { name: '共25条回复' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicC}/comments/${laterRoot}$`));
  await page.getByRole('button', { name: '当前按时间，点击切换为按热度' }).click();
  await page.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '2', exact: true }).click();
  await page.locator(`[data-reading-id="reply:${laterRoot}:${conversationEntry}"]`)
    .getByRole('button', { name: '查看对话' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/${conversationEntry}/conversation$`));
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(conversationCount);
  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/comments/${laterRoot}$`));
  await expect(page.getByRole('list', { name: '相关回复' }).locator('> li').first())
    .toHaveAttribute('data-reading-id', `reply:${laterRoot}:${hotSecondPageFirst}`);
  await page.getByRole('button', { name: '评论详情，返回动态详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/comments/${locatedRoot}/locate$`));
  await expect(page.locator(`[data-reading-id="comment:${locatedRoot}"]`)).toHaveAttribute('data-located', 'true');
  await expect(batch.getByRole('listitem')).toHaveCount(16);
  await expect.poll(async () => Math.abs((await scrollY(page)) - locatedScroll) <= 2).toBe(true);

  // 回复精确定位的第 3 页 → 会话（上下文不完整） → 返回仍是那一页与那个锚点。
  const locatedReply = '960022';
  await page.goto(`/dynamics/${dynamicC}/comments/${laterRoot}/replies/${locatedReply}/locate`);
  const located = page.locator(`[data-reading-id="reply:${laterRoot}:${locatedReply}"]`);
  await expect(located).toHaveAttribute('data-located', 'true');
  const replyPager = page.getByRole('navigation', { name: '回复分页' });
  await expect(replyPager.getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page');
  await located.getByRole('button', { name: '查看对话' }).click();
  await expect(page).toHaveURL(new RegExp(`/replies/${locatedReply}/conversation$`));
  await expect(page.getByText('部分上下文暂不可用')).toBeVisible();
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(2);
  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(replyPager.getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page');
  await expect(located).toHaveAttribute('data-located', 'true');

  // 无来源的会话页：直达与刷新都靠 URL 独立读取；返回替换为所属回复详情的时间序第 1 页。
  await page.goto(`/dynamics/${dynamicC}/comments/${laterRoot}/replies/${conversationEntry}/conversation`);
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(conversationCount);
  await page.reload();
  await expect(page.getByRole('list', { name: '对话内容' }).locator('> li')).toHaveCount(conversationCount);
  await page.getByRole('button', { name: '会话列表，返回评论详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicC}/comments/${laterRoot}$`));
  await expect(page.getByRole('list', { name: '相关回复' }).locator('> li').first())
    .toHaveAttribute('data-reading-id', `reply:${laterRoot}:${timeFirstId}`);
  await expect(page.getByRole('button', { name: '当前按时间，点击切换为按热度' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '回复分页' }).getByRole('button', { name: '1' }))
    .toHaveAttribute('aria-current', 'page');

  // 无来源的楼中楼页刷新后仍可读；返回替换为对应动态详情，不留在无效地址上。
  await page.goto(`/dynamics/${dynamicC}/comments/${laterRoot}`);
  await page.reload();
  await expect(page.getByRole('list', { name: '相关回复' }).locator('> li')).toHaveCount(10);
  await page.getByRole('button', { name: '评论详情，返回动态详情' }).click();
  await expect(page).toHaveURL(new RegExp(`/dynamics/${dynamicC}$`));
  await expect(page.getByRole('region', { name: '评论区' })).toBeVisible();

  // 只读：定位、会话与返回都不触发采集，归档内容不变。
  expect(await sourceRequests(page)).toEqual(before);
  expect(await archiveDocument(page, dynamicC)).toEqual(archiveC);
});
