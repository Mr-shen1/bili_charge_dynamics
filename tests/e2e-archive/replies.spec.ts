import { expect, test as base, type Locator, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logsOf, startApi, stopApi } from '../e2e-manage/apiProcess';

// 来源夹具故意倒序；首两条时间相同，以字符串 ID 决胜，末两条时间未知。
const replyIds = ['1010', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113',
  '114', '115', '116', '117', '118', '119', '120', '121', '122', '123', '124', '125'];
const replyPath = '/api/archive/dynamics/9101/comments/10/replies';
const ids = (rows: Locator) => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-reading-id')?.split(':').at(-1)));
const threadOf = (page: Page) => page.getByRole('region', { name: '回复区 10', exact: true });
const repliesOf = (thread: Locator) => thread.getByRole('list', { name: '回复列表', exact: true }).locator(':scope > li');

const test = base.extend<{ archiveApi: { reopen(): Promise<void> } }>({
  archiveApi: async ({ page }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'bili-replies-'));
    const database = join(directory, 'archive.sqlite');
    const factory = { factory: 'live_app:create_app', appDir: 'tests/e2e-archive', env: { FIXTURE_ROOT_COMMENTS: '1', FIXTURE_REPLIES: '1' } };
    let api: ChildProcess | undefined;
    try {
      api = await startApi(database, factory);
      await page.route('https://example.invalid/**', route => route.abort());
      expect((await page.request.post('/api/manage/ups', { data: { uid: '202' } })).status()).toBe(201);
      expect((await page.request.patch('/api/manage/ups/202/monitor', { data: { mode: 'specified', recent_n: 10, enabled: true } })).ok()).toBe(true);
      expect((await page.request.post('/api/manage/ups/202/targets', { data: { id: '9101' } })).status()).toBe(201);
      const initialized = await page.request.post('/api/sync/initial', { data: { uid: '202' } });
      expect(initialized.ok()).toBe(true);
      expect(await initialized.json()).toEqual({ processed: 1, succeeded: 1, failed: 0 });
      await use({ reopen: async () => {
        expect(logsOf(api!)).not.toContain('FICTIONAL_SECRET');
        await stopApi(api!);
        api = await startApi(database, { ...factory, env: { ...factory.env, FIXTURE_OFFLINE: '1' } });
        expect(await (await page.request.get('/api/archive/dynamics/9101')).json()).toMatchObject({
          source_comment_count: 501, local_comment_count: 45, local_reply_count: 25,
          root_comments_last_attempt: 'success', replies_last_attempt: 'success', comments_last_attempt: 'success',
          synced_comment_count: 501, work: { comments: 'success', replies: 'success' },
        });
      } });
      expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    } finally {
      if (api) await stopApi(api);
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test('实际 HTTP 与重开 SQLite 回复正序 3/13/23/25，收起复用且结束不再请求', async ({ page, archiveApi }) => {
  await archiveApi.reopen();
  const batch = await (await page.request.get(`${replyPath}?limit=3`)).json();
  expect(batch).toMatchObject({ source_reply_count: 25, local_reply_count: 25, replies_last_attempt: 'success' });
  expect(batch.items).toHaveLength(3);
  const requests: string[] = [];
  const completed: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === replyPath) requests.push(request.url());
  });
  page.on('response', response => {
    if (response.ok() && new URL(response.url()).pathname === replyPath) completed.push(response.url());
  });
  await page.goto('/dynamics/9101');
  const thread = threadOf(page);
  const rows = repliesOf(thread);
  await expect(rows).toHaveCount(3);
  expect(await ids(rows)).toEqual(replyIds.slice(0, 3));
  await expect(thread.getByText(/来源回复：/)).toHaveCount(0);
  const expand = thread.getByRole('button', { name: '展开回复', exact: true });
  await expect(expand).toHaveText('共25条回复，点击查看');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect(rows).toHaveCount(13);
  expect(await ids(rows)).toEqual(replyIds.slice(0, 13));
  await thread.getByRole('button', { name: '收起回复', exact: true }).click();
  await expect(rows).toHaveCount(3);
  const loaded = requests.length;
  await thread.getByRole('button', { name: '展开回复', exact: true }).click();
  await expect(rows).toHaveCount(13);
  expect(requests).toHaveLength(loaded);
  for (const count of [23, 25]) {
    await thread.getByRole('button', { name: '加载更多回复', exact: true }).click();
    await expect(rows).toHaveCount(count);
    expect(await ids(rows)).toEqual(replyIds.slice(0, count));
  }
  await expect(thread.getByText('回复已加载完毕', { exact: true })).toBeVisible();
  await expect(thread.getByRole('button', { name: '加载更多回复', exact: true })).toHaveCount(0);
  const ended = requests.length;
  await thread.getByText('回复已加载完毕', { exact: true }).click();
  await thread.getByRole('button', { name: '收起回复', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await thread.getByRole('button', { name: '展开回复', exact: true }).click();
  await expect(rows).toHaveCount(25);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150); // 仅给潜在的多余 HTTP 请求一个观察窗口。
  expect(requests).toHaveLength(ended);
  // StrictMode 可取消挂载首读；只断言实际成功批次，收起/结束仍观察所有请求。
  expect(completed.map(url => new URL(url).searchParams.get('limit'))).toEqual(['3', '10', '10', '10']);
  expect(completed.map(url => new URL(url).searchParams.has('cursor'))).toEqual([false, true, true, true]);
  await expect(page.locator('[data-reading-id="comment:2"]').getByRole('region', { name: /回复区/ })).toHaveCount(0);
});

const textMetrics = (text: Locator) => text.evaluate(element => {
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
  return { visibleLines: element.getBoundingClientRect().height / lineHeight, fullLines: element.scrollHeight / lineHeight };
});
const replyText = (row: Locator) => row.locator('p').filter({ hasText: /回复第1行/ });

test('实际回复六/七行折叠与安全文本，关系、同名 UP 和缺失字段按归档展示', async ({ page, archiveApi }) => {
  await archiveApi.reopen();
  // inline身份也计入渲染行：宽屏先保证前缀与首正文行同排，验证精确六/七行边界。
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dynamics/9101');
  const thread = threadOf(page);
  await expect(repliesOf(thread)).toHaveCount(3);
  const six = thread.locator('[data-reading-id="reply:10:1010"]');
  const seven = thread.locator('[data-reading-id="reply:10:102"]');
  const wrapped = thread.locator('[data-reading-id="reply:10:103"]');
  await expect(seven.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(1);
  expect((await textMetrics(replyText(six))).fullLines).toBeCloseTo(6, 1);
  await expect(six.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(0);
  expect((await textMetrics(replyText(seven))).visibleLines).toBeCloseTo(6, 1);
  await seven.getByRole('button', { name: '展开回复正文', exact: true }).click();
  expect((await textMetrics(replyText(seven))).visibleLines).toBeCloseTo(7, 1);
  await expect(replyText(seven)).toContainText('回复第7行 🙂');
  await seven.getByRole('button', { name: '收起回复正文', exact: true }).click();
  expect((await textMetrics(replyText(seven))).visibleLines).toBeCloseTo(6, 1);
  await page.setViewportSize({ width: 390, height: 800 });
  // 同一六行正文在窄屏因真实身份前缀换行达到七行，ResizeObserver必须新增展开入口。
  await expect(six.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(1);
  expect((await textMetrics(replyText(six))).visibleLines).toBeCloseTo(6, 1);
  await expect(wrapped.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(1);
  const safeText = wrapped.locator('p').filter({ hasText: /换行与 emoji/ });
  expect((await textMetrics(safeText)).fullLines).toBeGreaterThan(6);
  await wrapped.getByRole('button', { name: '展开回复正文', exact: true }).click();
  await expect(safeText).toContainText('https://example.invalid/');
  await expect(safeText).toContainText('<script>window.__replyFixtureExecuted = true</script>');
  expect(await safeText.textContent()).toContain('🙂\nhttps://');
  await expect(wrapped.locator('a, script')).toHaveCount(0);
  expect(await page.evaluate(() => '__replyFixtureExecuted' in window)).toBe(false);
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await expect(six.getByText('UP主', { exact: true })).toHaveCount(1);
  await expect(seven.getByText('UP主', { exact: true })).toHaveCount(0);
  await expect(seven.getByText('回复 @虚构初始作者', { exact: true })).toHaveCount(1);
  await expect(wrapped.getByText(/^回复 @/)).toHaveCount(0);
  await expect(wrapped.getByText('未知用户', { exact: true })).toHaveCount(1);
  await expect(wrapped.getByRole('group', { name: '点赞 —', exact: true })).toHaveCount(1);
  await expect(six.locator('img')).toHaveAttribute('src', '/default-avatar.svg');
  await six.getByText('虚构初始作者', { exact: true }).click();
  await six.locator('img').click();
  await six.getByRole('group', { name: '点赞 0', exact: true }).click();
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  await thread.getByRole('button', { name: '展开回复', exact: true }).click();
  await expect(repliesOf(thread)).toHaveCount(13);
  await thread.getByRole('button', { name: '加载更多回复', exact: true }).click();
  await expect(repliesOf(thread)).toHaveCount(23);
  await thread.getByRole('button', { name: '加载更多回复', exact: true }).click();
  await expect(repliesOf(thread)).toHaveCount(25);
  const empty = thread.locator('[data-reading-id="reply:10:125"]');
  await expect(empty.locator('time')).toHaveText('时间未知');
  await expect(empty.locator('p').filter({ hasText: '暂无评论内容' })).toHaveCount(1);
  await expect(thread).not.toContainText('undefined');
});

const hotIds = ['45', '10', '2', '40', '41', '1', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24',
  '25', '26', '27', '28', '29', '3', '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '4', '5', '6', '7', '8', '9', '42', '44', '43'];
const latestIds = ['44', '10', '2', '40', '41', '1', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24',
  '25', '26', '27', '28', '29', '3', '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '4', '5', '6', '7', '8', '9', '42', '43', '45'];
const top = (anchor: Locator) => anchor.evaluate(element => element.getBoundingClientRect().top);
const locate = (anchor: Locator) => anchor.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 40));

// 现有详情只有“返回列表”（POP），无法保留前一次详情再 PUSH 列表。
// 在已确认的浏览器历史 seam 建立新列表访问，不注入导航控件、不碰应用会话或快照。
// 两次详情仍由生产卡片/气泡进入，恢复仍由浏览器真实 back/forward 驱动。
const pushListVisit = async (page: Page, path: '/' | '/ups/202') => {
  await page.evaluate(path => {
    history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByRole('article')).toHaveCount(1);
};

test('同动态两个历史访问独立恢复排序、多批根/回复、文字、cursor 与位置，主动入口覆盖旧位置', async ({ page, archiveApi }) => {
  await archiveApi.reopen();
  await page.setViewportSize({ width: 390, height: 800 });
  const requests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/archive/dynamics/9101')) requests.push(request.url());
  });
  await page.goto('/');
  const card = page.getByRole('article').first();
  await card.getByRole('link', { name: '阅读全文 9101', exact: true }).click({ position: { x: 8, y: 8 } });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  const comments = page.getByRole('region', { name: '评论区', exact: true });
  const roots = comments.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
  const thread = threadOf(page);
  const replies = repliesOf(thread);
  const longReply = thread.locator('[data-reading-id="reply:10:102"]');
  const longRoot = comments.locator('[data-reading-id="comment:2"]');
  const replyAnchor = thread.locator('[data-reading-id="reply:10:110"]');
  const rootAnchor = comments.locator('[data-reading-id="comment:25"]');

  // 访问 A：最热，40 根，13 回复，根及回复正文展开，定位回复中的锚点。
  await expect(roots).toHaveCount(20);
  await expect(replies).toHaveCount(3);
  await longRoot.getByRole('button', { name: '展开评论', exact: true }).click();
  await longReply.getByRole('button', { name: '展开回复正文', exact: true }).click();
  await thread.getByRole('button', { name: '展开回复', exact: true }).click();
  await expect(replies).toHaveCount(13);
  await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(roots).toHaveCount(40);
  expect(await ids(roots)).toEqual(hotIds.slice(0, 40));
  await locate(replyAnchor);
  await expect.poll(() => top(replyAnchor)).toBeCloseTo(40, 0);
  const positionA = await page.evaluate(() => scrollY);

  await pushListVisit(page, '/ups/202');
  // 访问 B：同一动态的新气泡入口不借 A 的排序/批次/文本状态/位置。
  await card.getByRole('button', { name: '来源评论 501', exact: true }).click();
  await expect.poll(() => top(comments)).toBeCloseTo(0, 0);
  await expect(roots).toHaveCount(20);
  await expect(replies).toHaveCount(3);
  await expect(longRoot.getByRole('button', { name: '展开评论', exact: true })).toHaveCount(1);
  await expect(longReply.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(1);
  // 切排序同时重置回复范围和根/回复文本展开，而非复用另一排序的草稿。
  await thread.getByRole('button', { name: '展开回复', exact: true }).click();
  await expect(replies).toHaveCount(13);
  await longReply.getByRole('button', { name: '展开回复正文', exact: true }).click();
  await page.getByRole('button', { name: '最新', exact: true }).click();
  await expect(roots).toHaveCount(20);
  expect(await ids(roots)).toEqual(latestIds.slice(0, 20));
  await expect(replies).toHaveCount(3);
  await expect(longReply.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(1);
  await thread.getByRole('button', { name: '展开回复', exact: true }).click();
  await expect(replies).toHaveCount(13);
  await thread.getByRole('button', { name: '加载更多回复', exact: true }).click();
  await expect(replies).toHaveCount(23);
  await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(roots).toHaveCount(40);
  expect(await ids(roots)).toEqual(latestIds.slice(0, 40));
  await locate(rootAnchor);
  await expect.poll(() => top(rootAnchor)).toBeCloseTo(40, 0);
  const positionB = await page.evaluate(() => scrollY);
  expect(positionB).toBeGreaterThan(positionA + 500);
  await pushListVisit(page, '/');
  const loaded = requests.length;

  // B 与 A 同时在真实历史栈中；恢复须先有各自布局，才定位各自锚点。
  await page.goBack();
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  await expect(page.getByRole('button', { name: '最新', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(roots).toHaveCount(40);
  await expect(replies).toHaveCount(23);
  expect(await ids(roots)).toEqual(latestIds.slice(0, 40));
  expect(await ids(replies)).toEqual(replyIds.slice(0, 23));
  await expect(longReply.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(1);
  await expect.poll(() => top(rootAnchor)).toBeCloseTo(40, 0);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(positionB, 0);
  await page.goBack();
  await expect(page).toHaveURL(/\/ups\/202$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  await expect(page.getByRole('button', { name: '最热', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(roots).toHaveCount(40);
  await expect(replies).toHaveCount(13);
  expect(await ids(roots)).toEqual(hotIds.slice(0, 40));
  expect(await ids(replies)).toEqual(replyIds.slice(0, 13));
  await expect(longRoot.getByRole('button', { name: '收起评论', exact: true })).toHaveCount(1);
  await expect(longReply.getByRole('button', { name: '收起回复正文', exact: true })).toHaveCount(1);
  await expect.poll(() => top(replyAnchor)).toBeCloseTo(40, 0);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(positionA, 0);
  expect(requests).toHaveLength(loaded);

  // 从 A 各自保存的 cursor 继续，不重复首批，也不借用 B 的 23 条 cursor。
  await thread.getByRole('button', { name: '加载更多回复', exact: true }).click();
  await expect(replies).toHaveCount(23);
  expect(await ids(replies)).toEqual(replyIds.slice(0, 23));
  await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(roots).toHaveCount(45);
  expect(await ids(roots)).toEqual(hotIds);
  await locate(replyAnchor);
  await expect.poll(() => top(replyAnchor)).toBeCloseTo(40, 0);
  const continuedA = requests.length;
  await page.goForward();
  await expect(page).toHaveURL(/\/ups\/202$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  await expect(roots).toHaveCount(40);
  await expect(replies).toHaveCount(23);
  await expect(page.getByRole('button', { name: '最新', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(longRoot.getByRole('button', { name: '展开评论', exact: true })).toHaveCount(1);
  await expect(longReply.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(1);
  await expect.poll(() => top(rootAnchor)).toBeCloseTo(40, 0);
  expect(requests).toHaveLength(continuedA);
  // B 的独立 cursor 正确进入最后一批，A 的追加不能改变 B 的上下文。
  await thread.getByRole('button', { name: '加载更多回复', exact: true }).click();
  await expect(replies).toHaveCount(25);
  expect(await ids(replies)).toEqual(replyIds);
  await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(roots).toHaveCount(45);
  expect(await ids(roots)).toEqual(latestIds);
  await page.goBack();
  await expect(page).toHaveURL(/\/ups\/202$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  await expect(roots).toHaveCount(45);
  await expect(replies).toHaveCount(23);
  await expect(longReply.getByRole('button', { name: '收起回复正文', exact: true })).toHaveCount(1);
  await expect.poll(() => top(replyAnchor)).toBeCloseTo(40, 0);

  // 再主动访问顶部/评论入口，均不得被该动态旧历史位置拉回。
  await page.goForward();
  await expect(page).toHaveURL(/\/ups\/202$/);
  await card.getByRole('link', { name: '阅读全文 9101', exact: true }).click({ position: { x: 8, y: 8 } });
  await expect(roots).toHaveCount(20);
  await expect(replies).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(comments).not.toBeInViewport();
  await expect(longReply.getByRole('button', { name: '展开回复正文', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page).toHaveURL(/\/ups\/202$/);
  await card.getByRole('button', { name: '来源评论 501', exact: true }).click();
  await expect(roots).toHaveCount(20);
  await expect(replies).toHaveCount(3);
  await expect.poll(() => top(comments)).toBeCloseTo(0, 0);
  await expect(page.getByRole('button', { name: '最热', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
