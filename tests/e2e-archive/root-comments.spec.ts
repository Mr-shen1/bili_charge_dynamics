import { expect, test as base, type Locator } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logsOf, startApi, stopApi } from '../e2e-manage/apiProcess';

const hotIds = ['45', '10', '2', '40', '41', '1', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24',
  '25', '26', '27', '28', '29', '3', '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '4', '5', '6', '7', '8', '9', '42', '44', '43'];
const latestIds = ['44', '10', '2', '40', '41', '1', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23', '24',
  '25', '26', '27', '28', '29', '3', '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '4', '5', '6', '7', '8', '9', '42', '43', '45'];
const ids = (rows: Locator) => rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-reading-id')?.replace('comment:', '')));

const test = base.extend<{ archiveApi: { reopen(): Promise<void> } }>({
  archiveApi: async ({ page }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'bili-root-comments-'));
    const database = join(directory, 'archive.sqlite');
    const factory = { factory: 'live_app:create_app', appDir: 'tests/e2e-archive', env: { FIXTURE_ROOT_COMMENTS: '1' } };
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
      expect(await (await page.request.get('/api/archive/dynamics/9101')).json()).toMatchObject({
        source_comment_count: 501, local_comment_count: 45, local_reply_count: 0, root_comments_last_attempt: 'success',
      });
      await use({ reopen: async () => {
        expect(logsOf(api!)).not.toContain('FICTIONAL_SECRET');
        await stopApi(api!);
        api = await startApi(database, { ...factory, env: { ...factory.env, FIXTURE_OFFLINE: '1' } });
      } });
      expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    } finally {
      if (api) await stopApi(api);
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test('真实 SQLite/HTTP→详情：最热与最新完整排序，20/20/5 且结束不再请求', async ({ page, archiveApi }) => {
  await archiveApi.reopen();
  const requests: string[] = [];
  const completed: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/archive/dynamics/9101/comments') requests.push(request.url());
  });
  page.on('response', response => {
    if (response.ok() && new URL(response.url()).pathname === '/api/archive/dynamics/9101/comments') completed.push(response.url());
  });
  await page.goto('/dynamics/9101');
  const rows = page.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
  await expect(page.getByRole('button', { name: '最热', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const [sort, expected] of [['hot', hotIds], ['latest', latestIds]] as const) {
    if (sort === 'latest') await page.getByRole('button', { name: '最新', exact: true }).click();
    await expect(rows).toHaveCount(20);
    expect(await ids(rows)).toEqual(expected.slice(0, 20));
    await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
    await expect(rows).toHaveCount(40);
    expect(await ids(rows)).toEqual(expected.slice(0, 40));
    await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
    await expect(rows).toHaveCount(45);
    expect(await ids(rows)).toEqual(expected);
    await expect(page.getByText('本地归档评论已读完', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '加载更多评论', exact: true })).toHaveCount(0);
    const ended = requests.length;
    await page.mouse.wheel(0, 500);
    await page.getByText('本地归档评论已读完', { exact: true }).click();
    await page.waitForTimeout(150); // 给潜在的结束后读取一个观察窗口，不用于等待渲染。
    expect(requests).toHaveLength(ended);
  }
  expect(completed).toHaveLength(6);
  expect(completed.map(url => new URL(url).searchParams.get('sort'))).toEqual(['hot', 'hot', 'hot', 'latest', 'latest', 'latest']);
  expect(completed.map(url => new URL(url).searchParams.has('cursor'))).toEqual([false, true, true, false, true, true]);
});

const textMetrics = (text: Locator) => text.evaluate(element => {
  const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
  return { visibleLines: element.getBoundingClientRect().height / lineHeight, fullLines: element.scrollHeight / lineHeight };
});

test('真实归档评论按实际六/七行折叠，长 URL/emoji 安全文本随宽度重排', async ({ page, archiveApi }) => {
  await archiveApi.reopen();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/dynamics/9101');
  const rows = page.getByRole('list', { name: '一级评论', exact: true });
  const six = rows.locator('[data-reading-id="comment:10"]');
  const seven = rows.locator('[data-reading-id="comment:2"]');
  const wrapped = rows.locator('[data-reading-id="comment:40"]');
  await expect(seven.getByRole('button', { name: '展开评论', exact: true })).toHaveCount(1);
  expect((await textMetrics(six.locator('p').first())).fullLines).toBeCloseTo(6, 1);
  await expect(six.getByRole('button', { name: '展开评论', exact: true })).toHaveCount(0);
  expect((await textMetrics(seven.locator('p').first())).visibleLines).toBeCloseTo(6, 1);
  await seven.getByRole('button', { name: '展开评论', exact: true }).click();
  expect((await textMetrics(seven.locator('p').first())).visibleLines).toBeCloseTo(7, 1);
  await expect(seven.locator('p').first()).toContainText('第7行 🙂');
  await seven.getByRole('button', { name: '收起评论', exact: true }).click();
  expect((await textMetrics(seven.locator('p').first())).visibleLines).toBeCloseTo(6, 1);
  await expect(wrapped.getByRole('button', { name: '展开评论', exact: true })).toHaveCount(1);
  expect((await textMetrics(wrapped.locator('p').first())).fullLines).toBeGreaterThan(6);
  await wrapped.getByRole('button', { name: '展开评论', exact: true }).click();
  await expect(wrapped.locator('p').first()).toContainText('https://example.invalid/');
  await expect(wrapped.locator('p').first()).toContainText('<script>window.__commentFixtureExecuted = true</script>');
  await expect(wrapped.locator('a, script')).toHaveCount(0);
  expect(await page.evaluate(() => '__commentFixtureExecuted' in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await textMetrics(wrapped.locator('p').first())).fullLines).toBeLessThanOrEqual(6);
  await expect(wrapped.getByRole('button', { name: /评论$/ })).toHaveCount(0);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(wrapped.getByRole('button', { name: '收起评论', exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
});

async function expectNoArchiveInfo(card: Locator) {
  await expect(card).toBeVisible();
  await expect(card.getByRole('complementary', { name: '归档状态', includeHidden: true })).toHaveCount(0);
  await expect(card).not.toContainText(/编辑于|编辑信号|正文访问受限|正文尚未成功归档|最近正文|已保存内容仍可阅读|已有归档状态未覆盖|图片待归档（\d+ 张）|来源评论：|本地已归档|正文(?:已保存|待同步|读取失败|受限)；媒体/);
  await expect(card.getByText('暂无内容', { exact: true })).toHaveCount(0);
  await expect(card).toContainText('虚构首次归档正文');
}

test('列表详情无归档信息，来源气泡仍进入可读评论区且 UP 以作者 ID 标识', async ({ page, archiveApi }) => {
  await archiveApi.reopen();
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  const card = page.getByRole('article').first();
  const bubble = card.getByRole('button', { name: '来源评论 501', exact: true });
  await expect(bubble).toHaveCount(1);
  await expectNoArchiveInfo(card);
  await bubble.locator('svg').click();
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  const comments = page.getByRole('region', { name: '评论区', exact: true });
  await expectNoArchiveInfo(page.getByRole('article'));
  await expect(comments.getByRole('heading', { name: /评论.*501/ })).toBeVisible();
  await expect.poll(() => comments.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(0, 0);
  const rows = comments.getByRole('list', { name: '一级评论', exact: true });
  await expect(rows.locator(':scope > li')).toHaveCount(20);
  const author = rows.locator('[data-reading-id="comment:10"]');
  const namesake = rows.locator('[data-reading-id="comment:2"]');
  await expect(author.getByText('虚构初始作者', { exact: true })).toHaveCount(1);
  await expect(namesake.getByText('虚构初始作者', { exact: true })).toHaveCount(1);
  await expect(author.getByText('UP主', { exact: true })).toHaveCount(1);
  await expect(namesake.getByText('UP主', { exact: true })).toHaveCount(0);
  await expect(author.locator('time')).toHaveText('2026-10-09 10:38:18');
  await expect(rows.locator('[data-reading-id="comment:45"]').locator('time')).toHaveText('时间未知');
  await expect(author.locator('img')).toHaveAttribute('src', '/default-avatar.svg');
  await author.getByText('虚构初始作者', { exact: true }).click();
  await author.locator('img').click();
  await author.getByRole('group', { name: '点赞 1', exact: true }).click();
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  await expect(page.getByRole('button', { name: '查看详情', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await card.getByRole('link', { name: '阅读全文 9101', exact: true }).click({ position: { x: 8, y: 8 } });
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(comments).not.toBeInViewport();
  await expect(page.getByRole('article').getByRole('button', { name: '展开正文', exact: true })).toHaveCount(0);
  await comments.getByRole('button', { name: '来源评论 501', exact: true }).click();
  await expect.poll(() => comments.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(0, 0);
  // 数量文本也是同一个入口，主动定位不能借用刚才的顶部/历史位置。
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await bubble.getByText('501', { exact: true }).click();
  await expect.poll(() => comments.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(0, 0);
  await expectNoArchiveInfo(page.getByRole('article'));
  await expect(rows.locator(':scope > li')).toHaveCount(20);
  expect(await (await page.request.get('/api/archive/dynamics/9101')).json()).toMatchObject({
    source_comment_count: 501, local_comment_count: 45, local_reply_count: 0,
  });
});

const top = (anchor: Locator) => anchor.evaluate(element => element.getBoundingClientRect().top);
const locate = (anchor: Locator) => anchor.evaluate(element => window.scrollTo(0, scrollY + element.getBoundingClientRect().top - 40));

test('历史恢复本次详情的排序、多批、文字展开与位置，新主动访问不借用旧快照', async ({ page, archiveApi }) => {
  await archiveApi.reopen();
  await page.setViewportSize({ width: 390, height: 800 });
  const requests: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/archive/dynamics/9101/comments') requests.push(request.url());
  });
  await page.goto('/');
  const card = page.getByRole('article').first();
  await card.getByRole('button', { name: '展开正文', exact: true }).click();
  await card.getByRole('button', { name: '来源评论 501', exact: true }).click();
  const comments = page.getByRole('region', { name: '评论区', exact: true });
  const rows = comments.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
  const seven = comments.locator('[data-reading-id="comment:2"]');
  await expect(rows).toHaveCount(20);
  await seven.getByRole('button', { name: '展开评论', exact: true }).click();
  await page.getByRole('button', { name: '最新', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect.poll(() => top(comments)).toBeCloseTo(0, 0);
  await expect(seven.getByRole('button', { name: '展开评论', exact: true })).toHaveCount(1);
  await seven.getByRole('button', { name: '展开评论', exact: true }).click();
  await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(rows).toHaveCount(40);
  const anchor = comments.locator('[data-reading-id="comment:25"]');
  await locate(anchor);
  await expect.poll(() => top(anchor)).toBeCloseTo(40, 0);
  const oldScroll = await page.evaluate(() => scrollY);
  const loaded = requests.length;
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(card.getByRole('button', { name: '收起正文', exact: true })).toHaveCount(1);
  await page.goForward();
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  await expect(page.getByRole('button', { name: '最新', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(40);
  expect(await ids(rows)).toEqual(latestIds.slice(0, 40));
  await expect(seven.getByRole('button', { name: '收起评论', exact: true })).toHaveCount(1);
  await expect.poll(() => top(anchor)).toBeCloseTo(40, 0);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeCloseTo(oldScroll, 0);
  expect(requests).toHaveLength(loaded);
  // 恢复的 cursor 仍可读取最终批，而非悄悄重复第一页。
  await page.getByRole('button', { name: '加载更多评论', exact: true }).click();
  await expect(rows).toHaveCount(45);
  expect(await ids(rows)).toEqual(latestIds);
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await card.getByRole('link', { name: '阅读全文 9101', exact: true }).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await expect(page.getByRole('button', { name: '最热', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(20);
  expect(await ids(rows)).toEqual(hotIds.slice(0, 20));
  await expect(seven.getByRole('button', { name: '展开评论', exact: true })).toHaveCount(1);
});
