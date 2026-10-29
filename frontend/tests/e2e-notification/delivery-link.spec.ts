import { expect, test, type Page } from '@playwright/test';

// 04：从**实际归档链**驱动飞书替身，取消息里真实生成的链接进生产浏览器读取并验证目标。
// 后端是 backend/tests/live_app（虚构上游 + 本次运行独占 SQLite），通知走真实 Dispatcher/
// 消息模板/发件箱；页面是生产装配。链接从投递产物里取，不在测试里另拼一套入口。

const uid = '808';
const dynamicId = '800300';
const total = 45;
// 45 条虚构根评论按点赞递减归档：最热顺序 860001…860045，第 26 条落在第二批。
const freshIndex = 26;
const targetId = String(860000 + freshIndex);

test.describe.configure({ mode: 'serial' });

let deliveredLink = '';
let messageText = '';

function payloadText(payload: unknown): string {
  const content = (payload as { content: { post: { zh_cn: { content: Array<Array<{ text?: string }>> } } } })
    .content.post.zh_cn.content;
  return content.map(paragraph => paragraph.map(node => node.text ?? '').join('')).join('\n');
}

function payloadLink(payload: unknown): string {
  const content = (payload as {
    content: { post: { zh_cn: { content: Array<Array<{ tag?: string; href?: string }>> } } };
  }).content.post.zh_cn.content;
  const node = content.flat().find(item => item.tag === 'a');
  return node?.href ?? '';
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:4326' });
  try {
    // 启用监控（建立通知起点）→ 第 26 条按“刚发表”下发 → 真实初始化归档 → 真实通知投递。
    expect((await api.post('/api/manage/ups', { data: { uid } })).status()).toBe(201);
    expect((await api.patch(`/api/manage/ups/${uid}/monitor`,
      { data: { mode: 'specified', recent_n: 10, enabled: true } })).status()).toBe(200);
    expect((await api.post('/api/test/root-comments',
      { data: { dynamic: dynamicId, fresh: [freshIndex] } })).status()).toBe(200);
    expect((await api.post(`/api/manage/ups/${uid}/targets`, { data: { id: dynamicId } })).status()).toBe(201);
    const sync = await api.post('/api/sync/initial', { data: { uid } });
    expect(sync.status()).toBe(200);
    expect(await sync.json()).toMatchObject({ processed: 1, succeeded: 1 });

    const notified = await api.post('/api/test/notify-roots');
    expect(notified.status()).toBe(200);
    const delivered = (await notified.json()).delivered as Array<{ url: string; payload: unknown }>;
    // UP 本人的评论同时进 UP 群和全员群：两条投递、同一个实际链接。
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

test('投递产物链接直接打开即定位到该条评论（第二批）', async ({ page }) => {
  expect(deliveredLink).toBe(`http://127.0.0.1:4326/dynamics/${dynamicId}/comments/${targetId}/locate`);
  // 链接携带的就是这条评论的身份，不是动态页或楼中楼页。
  expect(messageText).toContain(`动态：${dynamicId}`);
  expect(messageText).toContain('评论人：【');
  expect(messageText).toContain('内容：虚构一级评论 26');

  // 目标确实不在首批：页面默认按时间，普通评论接口的首批 20 条里没有它。
  const first = await (await page.request.get(`/api/archive/dynamics/${dynamicId}/comments?sort=latest&limit=20`)).json();
  expect(first.items).toHaveLength(20);
  expect(first.items.some((item: { id: string }) => item.id === targetId)).toBe(false);

  await page.goto(deliveredLink);
  const region = page.getByRole('region', { name: '评论区' });
  await expect(page.locator(`[data-reading-id="comment:${targetId}"]`)).toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  // 定位落在目标评论本身，而不是列表顶部。
  await expect.poll(() => page.locator(`[data-reading-id="comment:${targetId}"]`)
    .evaluate(element => Math.round(element.getBoundingClientRect().top))).toBeLessThan(24);
  await expect(region.getByRole('listitem')).toHaveCount(20);
});

test('同一条投递链接在窄屏刷新后仍定位同一条评论', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(deliveredLink);
  await page.reload();
  await expect(page.locator(`[data-reading-id="comment:${targetId}"]`)).toHaveAttribute('data-located', 'true');
  await expect(located(page)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  // 打开消息链接不触发采集：归档仍是初始化时的那 45 条。
  const archive = await (await page.request.get(`/api/archive/dynamics/${dynamicId}`)).json();
  expect(archive.local_comment_count).toBe(total);
});
