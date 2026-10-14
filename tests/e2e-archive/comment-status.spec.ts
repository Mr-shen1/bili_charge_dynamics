import { expect, test as base, type APIRequestContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logsOf, startApi, stopApi } from '../e2e-manage/apiProcess';
import { command } from './commentStatusProcess';

const archive = '/api/archive/dynamics/9101';
const checks = '/api/manage/ups/202/checks';

async function readAll(api: APIRequestContext, path: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  do {
    const response = await api.get(path, { params: cursor ? { cursor } : {} });
    expect(response.ok()).toBe(true);
    const batch = await response.json();
    items.push(...batch.items);
    cursor = batch.next_cursor;
  } while (cursor !== null);
  return items;
}
const test = base.extend<{ collector: {
  command(action: Parameters<typeof command>[1]): ReturnType<typeof command>;
  reopen(): Promise<void>;
} }>({
  collector: async ({ page }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'bili-status-'));
    const socket = join(directory, 'control.sock');
    const database = join(directory, 'archive.sqlite');
    const factory = {
      factory: 'comment_status_app:create_app', appDir: 'tests/e2e-archive',
      env: { FIXTURE_CONTROL_SOCKET: socket },
    };
    let api = await startApi(database, factory);
    try {
      await page.route('https://example.invalid/**', route => route.abort());
      expect((await page.request.post('/api/manage/ups', { data: { uid: '202' } })).status()).toBe(201);
      expect((await page.request.patch('/api/manage/ups/202/monitor', {
        data: { mode: 'specified', recent_n: 10, enabled: true },
      })).ok()).toBe(true);
      for (const id of ['9101', '9102', '9105']) {
        expect((await page.request.post('/api/manage/ups/202/targets', { data: { id } })).status()).toBe(201);
      }
      await use({ command: action => command(socket, action), reopen: async () => {
        expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
        await stopApi(api);
        api = await startApi(database, factory);
      } });
      expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    } finally {
      await stopApi(api);
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test('原始协议经 Collector/SQLite/真实 HTTP 产生同步中、回复页失败、无新计数重试及未知/真实零', async ({ page, collector }) => {
  await collector.command('check');
  await collector.command('execute-start');
  const running = await (await page.request.get(checks)).json();
  expect(running.checks.find((item: { id: string }) => item.id === '9101')).toMatchObject({
    work: 'running', observed: { source_comment_count: 501 },
  });
  await collector.command('release-failure');
  const failed = await (await page.request.get(checks)).json();
  const partial = failed.checks.find((item: { id: string }) => item.id === '9101');
  expect(partial).toMatchObject({ work: 'pending', sync_error: 'SYNC_INCOMPLETE' });
  expect((await (await page.request.get(archive)).json()).comment_sync).toEqual(partial);
  expect(await (await page.request.get(archive)).json()).toMatchObject({
    source_comment_count: 501, local_comment_count: 45, local_reply_count: 20,
    root_comments_last_attempt: 'success', replies_last_attempt: 'failed',
  });
  const rootsBefore = await (await page.request.get(archive + '/comments')).json();
  const repliesBefore = await (await page.request.get(archive + '/comments/10/replies')).json();
  expect(rootsBefore.items).toHaveLength(20);
  expect(repliesBefore.items).toHaveLength(3); // 回复 HTTP 默认首批 3；本地完整计数仍为 20。
  expect(await (await page.request.get('/api/archive/dynamics/9102')).json()).toMatchObject({
    source_comment_count: 0, local_comment_count: 0, local_reply_count: 0,
    root_comments_last_attempt: 'success', replies_last_attempt: 'success',
  });
  expect(await (await page.request.get('/api/archive/dynamics/9105')).json()).toMatchObject({
    source_comment_count: null, local_comment_count: 0, root_comments_last_attempt: 'failed',
  });
  await collector.command('retry');
  const succeeded = await (await page.request.get(checks)).json();
  const complete = succeeded.checks.find((item: { id: string }) => item.id === '9101');
  expect(complete).toMatchObject({ work: 'complete', sync_error: null,
    revision: partial.revision, observed: { source_comment_count: 501 } });
  expect(await (await page.request.get(archive)).json()).toMatchObject({
    source_comment_count: 501, local_comment_count: 45, local_reply_count: 25,
    root_comments_last_attempt: 'success', replies_last_attempt: 'success',
  });
  expect((await (await page.request.get(archive + '/comments')).json()).items).toEqual(rootsBefore.items);
  const repliesAfter = await readAll(page.request, archive + '/comments/10/replies');
  expect(repliesAfter).toHaveLength(25);
  expect(repliesAfter).toEqual(expect.arrayContaining(repliesBefore.items));
  expect(JSON.stringify({ running, failed, succeeded })).not.toContain('FICTIONAL_SECRET');
  await collector.command('check');
  const unchanged = await (await page.request.get(checks)).json();
  expect(unchanged.checks.find((item: { id: string }) => item.id === '9101')).toMatchObject({
    check_status: 'unchanged', revision: partial.revision, work: 'complete',
    last_succeeded_at: complete.last_succeeded_at,
    root_comments_last_succeeded_at: complete.root_comments_last_succeeded_at,
    replies_last_succeeded_at: complete.replies_last_succeeded_at,
    comments_last_succeeded_at: complete.comments_last_succeeded_at,
  });
  await collector.reopen();
  expect(await (await page.request.get(checks)).json()).toEqual(unchanged);
  expect(await (await page.request.get(archive)).json()).toMatchObject({
    source_comment_count: 501, local_comment_count: 45, local_reply_count: 25,
    root_comments_last_attempt: 'success', replies_last_attempt: 'success',
  });
  expect((await (await page.request.get(archive + '/comments')).json()).items).toEqual(rootsBefore.items);
  expect((await collector.command('calls')).calls).toEqual([]);
});

test('实际 API→生产 Adapter→详情：部分失败无新计数恢复，状态 GET 保留多批评论、排序、展开与位置', async ({ page, collector }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await collector.command('check');
  await collector.command('execute-start');
  const requests: { path: string; method: string }[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) requests.push({ path, method: request.method() });
  });
  await page.goto('/dynamics/9101');
  const comments = page.getByRole('region', { name: '评论区', exact: true });
  const rows = comments.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
  await expect(rows).toHaveCount(20);
  const status = comments.getByRole('complementary', { name: '评论归档状态', exact: true });
  await expect(status).toContainText('来源评论总数：501；本地一级评论：45；本地回复：20；当前已加载一级评论：20。');
  await expect(status).toContainText('评论同步中；已有归档仍可阅读。');
  await collector.command('release-failure');
  const readStatus = comments.getByRole('button', { name: '读取评论同步状态', exact: true });
  const callsBeforeRefresh = (await collector.command('calls')).calls;
  await readStatus.click();
  await expect(status).toContainText('评论部分完成，最近同步失败，待后台重试。');
  await expect(rows).toHaveCount(20);
  expect((await collector.command('calls')).calls).toEqual(callsBeforeRefresh);
  await page.getByRole('button', { name: '最新', exact: true }).click();
  await expect(rows).toHaveCount(20);
  const seven = comments.locator('[data-reading-id="comment:2"]');
  await seven.getByRole('button', { name: '展开评论', exact: true }).click();
  await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(rows).toHaveCount(40);
  await expect(status).toContainText('当前已加载一级评论：40。');
  const beforeIds = await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-reading-id')));
  await collector.command('retry');
  const sourceCalls = (await collector.command('calls')).calls;
  const refresh = comments.getByRole('button', { name: '重新读取评论同步状态', exact: true });
  const anchor = comments.locator('[data-reading-id="comment:25"]');
  await anchor.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 40));
  await expect.poll(() => anchor.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(40, 0);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const requestCount = requests.length;
  // 键盘触发已聚焦的只读按钮，不让 Playwright 的自动滚动掩盖原阅读位置是否跳动。
  await refresh.evaluate(element => element.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
  await expect(status).toContainText('来源评论总数：501；本地一级评论：45；本地回复：25；当前已加载一级评论：40。');
  await expect(status).toContainText('本轮评论文本已完成；不代表拥有完整来源评论或实时更新。');
  await expect(rows).toHaveCount(40);
  expect(await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-reading-id')))).toEqual(beforeIds);
  await expect(page.getByRole('button', { name: '最新', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(seven.getByRole('button', { name: '收起评论', exact: true })).toHaveCount(1);
  // 状态文案换行可能改变文档高度；验证读者所在评论仍在原视口位置，而非锁死绝对 scrollY。
  expect(await anchor.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(40, 0);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  const refreshRequests = requests.slice(requestCount);
  expect(refreshRequests.length).toBeGreaterThan(0);
  expect(refreshRequests.every(request => request.method === 'GET')).toBe(true);
  expect(refreshRequests.some(request => request.path.endsWith('/comments'))).toBe(false);
  expect((await collector.command('calls')).calls).toEqual(sourceCalls);
  expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
  expect(await page.evaluate(() => '__fixtureExecuted' in window)).toBe(false);

  await page.goto('/dynamics/9102');
  await expect(status).toContainText('来源评论总数：0；本地一级评论：0；本地回复：0；当前已加载一级评论：0。');
  await expect(status).toContainText('本轮评论文本已完成；不代表拥有完整来源评论或实时更新。');
  await expect(comments.getByText('暂无评论', { exact: true })).toBeVisible();
  await page.goto('/dynamics/9105');
  await expect(status).toContainText('来源评论总数：—；本地一级评论：0；本地回复：0；当前已加载一级评论：0。');
  await expect(status).toContainText('评论同步失败，待后台重试。');
  await expect(comments.getByText('暂无评论', { exact: true })).toHaveCount(0);
});
