import { expect, test as base, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logsOf, startApi, stopApi } from '../e2e-manage/apiProcess';
import { command } from './commentStatusProcess';

const test = base.extend<{ lifecycle: {
  command(action: Parameters<typeof command>[1]): ReturnType<typeof command>;
  reopenOffline(): Promise<void>;
  reopenUpdated(): Promise<void>;
} }>({
  lifecycle: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'bili-lifecycle-'));
    const database = join(directory, 'archive.sqlite');
    const socket = join(directory, 'control.sock');
    const factory = { factory: 'lifecycle_live_app:create_app', appDir: 'tests/e2e-archive',
      env: { FIXTURE_CONTROL_SOCKET: socket } };
    let api = await startApi(database, factory);
    async function reopen(env: Record<string, string>) {
      expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
      await stopApi(api);
      api = await startApi(database, { ...factory, env: { ...factory.env, ...env } });
    }
    try {
      await use({ command: action => command(socket, action),
        reopenOffline: () => reopen({ FIXTURE_OFFLINE: '1' }),
        reopenUpdated: () => reopen({ FIXTURE_VERSION: '2', FIXTURE_CLOCK: '2026-10-09T05:12:00+00:00' }),
      });
      expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    } finally {
      await stopApi(api);
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function imageBoundary(page: Page) {
  const sources: string[] = [];
  page.on('request', request => { if (request.resourceType() === 'image') sources.push(request.url()); });
  // 只控制外部图片；所有 API 都经过生产 HTTP/Adapter，不拦截或伪造 API 响应。
  await page.route('https://**/*', route => new URL(route.request().url()).host === 'archive-media.example.invalid'
    ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"/>' })
    : route.abort());
  return sources;
}

async function manageTarget(page: Page) {
  await page.goto('/manage');
  await page.getByRole('textbox', { name: 'UP UID', exact: true }).fill('202');
  await page.getByRole('button', { name: '添加监控', exact: true }).click();
  // UP 列表只列身份与状态，配置、目标与检查状态在单 UP 管理页。
  await page.getByRole('link', { name: '管理 UP 202', exact: true }).click();
  const up = page.getByRole('article', { name: 'UP 202', exact: true });
  await expect(up).toContainText('虚构生命周期作者');
  await up.getByRole('combobox', { name: '监控模式', exact: true }).selectOption('specified');
  await up.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(up).toContainText('已保存模式：指定动态 ID');
  await expect(up).toContainText('监控已启用');
  await up.getByRole('textbox', { name: '动态 ID', exact: true }).fill('9101');
  await up.getByRole('button', { name: '校验并添加目标', exact: true }).click();
  await expect(up).toContainText('归属校验通过，目标关联已保存。');
  return up;
}

const checks = '/api/manage/ups/202/checks';
const archive = '/api/archive/dynamics/9101';

test('浏览器管理→Collector→真实归档阅读，停用/删目标/删配置并断源重开仍从选择条进入、预览及返回恢复', async ({ page, lifecycle }) => {
  const sources = await imageBoundary(page);
  const up = await manageTarget(page);
  await lifecycle.command('check');
  await lifecycle.command('retry');
  expect((await (await page.request.get(checks)).json()).checks[0]).toMatchObject({ work: 'complete' });

  const persisted = await (await page.request.get(archive)).json();
  expect(persisted).toMatchObject({ source_comment_count: 501, local_comment_count: 45, local_reply_count: 25 });
  await up.getByRole('button', { name: '停止监控', exact: true }).click();
  await expect(up).toContainText('监控已停止');
  await page.getByRole('link', { name: '返回阅读', exact: true }).click();
  const scope = page.getByRole('navigation', { name: '归档范围', exact: true });
  await scope.getByRole('link', { name: '虚构生命周期作者', exact: true }).click();
  await expect(page).toHaveURL(/\/ups\/202$/);
  const card = page.getByRole('article');
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: '展开正文', exact: true }).click();
  await card.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  await expect(page).toHaveURL(/\/dynamics\/9101$/);
  const roots = page.getByRole('list', { name: '一级评论', exact: true }).locator(':scope > li');
  await expect(roots).toHaveCount(20);
  const thread = page.getByRole('region', { name: '回复区 10', exact: true });
  await expect(thread.getByRole('list', { name: '回复列表', exact: true }).locator(':scope > li')).toHaveCount(3);
  await thread.getByRole('button', { name: '展开回复', exact: true }).click();
  await expect(thread.getByRole('list', { name: '回复列表', exact: true }).locator(':scope > li')).toHaveCount(13);
  const comment = page.locator('[data-reading-id="comment:45"]');
  const commentImage = comment.getByRole('button', { name: '预览图片 1', exact: true });
  await commentImage.click();
  const preview = page.getByRole('dialog', { name: '图片预览', exact: true });
  await expect(preview.getByText('1 / 1', { exact: true })).toBeVisible();
  await expect(preview.getByRole('img')).toHaveAttribute('src', /https:\/\/archive-media\.example\.invalid\//);
  await page.keyboard.press('Escape');
  await expect(commentImage).toBeFocused();
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page).toHaveURL(/\/ups\/202$/);
  await expect(card.getByRole('button', { name: '收起正文', exact: true })).toBeVisible();

  await page.goto('/manage/ups/202');
  await up.getByRole('button', { name: '移除目标 9101', exact: true }).click();
  await expect(up).toContainText('目标已移除；已有归档保留。');
  await up.getByRole('button', { name: '删除监控配置', exact: true }).click();
  await expect(up).toContainText('监控配置已删除；身份和已有归档保留。');
  await lifecycle.reopenOffline();
  const sourceCalls = (await lifecycle.command('calls')).calls;
  const browserWrites: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET') browserWrites.push(request.url());
  });
  await page.goto('/');
  await expect(card).toHaveCount(1);
  await scope.getByRole('link', { name: '虚构生命周期作者', exact: true }).click();
  await expect(page).toHaveURL(/\/ups\/202$/);
  await card.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  await expect(roots).toHaveCount(20);
  await expect(thread.getByRole('list', { name: '回复列表', exact: true }).locator(':scope > li')).toHaveCount(3);
  const dynamicImage = page.getByRole('group', { name: '动态图片', exact: true }).getByRole('button', { name: '预览图片 1', exact: true });
  await dynamicImage.click();
  await expect(preview.getByRole('img')).toHaveAttribute('src', persisted.media[0].public_url);
  await page.keyboard.press('Escape');
  await commentImage.click();
  await expect(preview.getByRole('img')).not.toHaveAttribute('src', persisted.media[0].public_url);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page).toHaveURL(/\/ups\/202$/);
  expect(await (await page.request.get(archive)).json()).toMatchObject({ text: persisted.text, media: persisted.media });
  expect((await lifecycle.command('calls')).calls).toEqual(sourceCalls);
  expect(browserWrites).toEqual([]);
  expect(sources.some(url => url.startsWith('https://archive-media.example.invalid/'))).toBe(true);
  expect(sources.filter(url => url.includes('hdslb.com') || url.includes('source-business'))).toEqual([]);
  expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
  expect(await page.evaluate(() => '__fixtureExecuted' in window)).toBe(false);
});

test('管理分项状态贯穿可信编辑/计数变化、媒体失败、重开及无新信号重试，不把评论成功当作整轮成功', async ({ page, lifecycle }) => {
  const sources = await imageBoundary(page);
  const up = await manageTarget(page);
  const state = up.getByRole('region', { name: '动态 9101 检查状态', exact: true });
  const read = async () => {
    const before = (await lifecycle.command('calls')).calls;
    await up.getByRole('button', { name: /^(重新)?读取检查状态$/ }).click();
    await expect(state).toBeVisible();
    // 每条动态默认折叠详情；重新加载或刷新后仍折叠，这里逐次展开以读取分项行。
    const expand = state.getByRole('button', { name: '展开动态 9101 详情' });
    if (await expand.count()) await expand.click();
    expect((await lifecycle.command('calls')).calls).toEqual(before);
  };
  await read();
  await expect(state).toContainText('未检查');
  await expect(state).toContainText('尚无检查工作');
  await expect(state).toContainText('实际整轮成功：尚未成功');
  await expect(state).toContainText('正文最近成功：—');
  await expect(state).toContainText('动态图最近成功：—');
  await expect(state).toContainText('评论图最近成功：—');
  await lifecycle.command('check');
  await read();
  await expect(state).toContainText('已检查，已登记观察。');
  await expect(state).toContainText('最近检查：2026-10-09 13:10:00');
  await expect(state).toContainText('观察与正文成功版本不一致');
  await expect(state).toContainText('实际整轮成功：尚未成功');
  await lifecycle.command('retry');
  await read();
  await expect(state).toContainText('对应观察已完成');
  await expect(state).toContainText('正文已保存；动态图已保存；评论已保存；回复已保存；评论图已保存。');
  await expect(state).toContainText('实际整轮成功：2026-10-09 13:10:00');
  await expect(state).toContainText('正文最近成功：2026-10-09 13:10:00');
  await expect(state).toContainText('动态图最近成功：2026-10-09 13:10:00');
  await expect(state).toContainText('评论图最近成功：2026-10-09 13:10:00');
  const baseline = (await (await page.request.get(checks)).json()).checks[0];

  await lifecycle.command('execute-start');
  await read();
  await expect(state.getByText('同步中', { exact: true })).toBeVisible();
  await expect(state).toContainText('来源评论总数：502');
  await expect(state).toContainText('最近检查：2026-10-09 13:11:00');
  await expect(state).not.toContainText('对应观察已完成');
  await lifecycle.command('release-failure');
  await read();
  await expect(state.getByText('部分完成', { exact: true })).toBeVisible();
  await expect(state).toContainText('正文已保存；动态图待处理；评论已保存；回复已保存；评论图待处理。');
  await expect(state).toContainText('评论同步：对应评论观察已完成');
  await expect(state).toContainText('本地根评论数：46');
  await expect(state).toContainText('本地回复数：26');
  await expect(state).toContainText('评论整轮成功计数（来源总数）：502');
  await expect(state).toContainText('实际整轮成功：2026-10-09 13:10:00');
  await expect(state).toContainText('根评论最近成功：2026-10-09 13:11:00');
  await expect(state).toContainText('回复最近成功：2026-10-09 13:11:00');
  await expect(state).toContainText('同步未全部完成，将在固定节拍重试。');
  await expect(state).toContainText('正文最近成功：2026-10-09 13:11:00');
  await expect(state).toContainText('动态图最近成功：2026-10-09 13:10:00');
  await expect(state).toContainText('评论图最近成功：2026-10-09 13:10:00');
  await expect(state).toContainText('动态图：图片上传失败；保留已有归档，将在固定节拍重试。');
  await expect(state).toContainText('评论图：图片上传失败；保留已有归档，将在固定节拍重试。');
  await expect(state).not.toContainText('对应观察已完成');
  const partial = (await (await page.request.get(checks)).json()).checks[0];
  expect(partial).toMatchObject({ work: 'pending', sync_error: 'SYNC_INCOMPLETE',
    last_succeeded_at: baseline.last_succeeded_at, synced_comment_count: 502,
    media_last_succeeded_at: baseline.media_last_succeeded_at,
    comment_media_last_succeeded_at: baseline.comment_media_last_succeeded_at,
    media_errors: ['MEDIA_UPLOAD_FAILED'], comment_media_errors: ['MEDIA_UPLOAD_FAILED'] });
  expect(partial.revision).toBeGreaterThan(baseline.revision);
  expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
  const failedArchive = await (await page.request.get(archive)).json();
  expect(failedArchive).toMatchObject({ source_comment_count: 502, local_comment_count: 46, local_reply_count: 26,
    published_at: '2026-10-09T10:38:16+08:00', edited_at: '2026-10-09T13:02+08:00', comments_last_attempt: 'success',
    media: [{ status: 'success' }, { status: 'failed', public_url: null }] });
  expect(JSON.stringify({ partial, failedArchive })).not.toContain('FICTIONAL_SECRET');

  await page.goto('/');
  const card = page.getByRole('article');
  await expect(card).toContainText('可信编辑后的生命周期正文');
  await card.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  await expect(page.getByText('计数变化新增评论', { exact: true })).toBeVisible();
  const comment = page.locator('[data-reading-id="comment:45"]');
  await expect(comment.getByRole('group', { name: '评论图片', exact: true }).getByRole('button', { name: /^预览图片/ })).toHaveCount(2);
  await expect(comment.getByText('图片归档失败', { exact: true })).toBeVisible();
  await expect(comment.getByText('暂无评论内容', { exact: true })).toHaveCount(0);
  const dynamic = page.getByRole('group', { name: '动态图片', exact: true });
  await expect(dynamic.getByRole('img', { name: '图片 1', exact: true })).toHaveAttribute('src', failedArchive.media[0].public_url);
  await expect(dynamic.getByText('图片归档失败', { exact: true })).toBeVisible();

  // 重开真实 SQLite 后先读 pending，不通过浏览器或重新初始化偷偷完成工作。
  await lifecycle.reopenUpdated();
  expect((await (await page.request.get(checks)).json()).checks[0]).toEqual(partial);
  expect((await lifecycle.command('calls')).calls).toEqual([]);
  await lifecycle.command('check');
  await page.goto('/manage/ups/202');
  await read();
  await expect(state).toContainText('检查无变化；不代表同步完成。');
  await expect(state).toContainText('最近检查：2026-10-09 13:12:00');
  await expect(state).toContainText('正文最近成功：2026-10-09 13:11:00');
  await expect(state).toContainText('动态图最近成功：2026-10-09 13:10:00');
  await expect(state).toContainText('评论图最近成功：2026-10-09 13:10:00');
  await expect(state).toContainText('动态图：图片上传失败；保留已有归档，将在固定节拍重试。');
  await expect(state).toContainText('评论图：图片上传失败；保留已有归档，将在固定节拍重试。');
  await expect(state.getByText('部分完成', { exact: true })).toBeVisible();
  await expect(state).toContainText('实际整轮成功：2026-10-09 13:10:00');
  const beforeRetry = (await lifecycle.command('calls')).calls;
  await lifecycle.command('retry');
  await read();
  await expect(state).toContainText('对应观察已完成');
  await expect(state).toContainText('正文已保存；动态图已保存；评论已保存；回复已保存；评论图已保存。');
  await expect(state).toContainText('实际整轮成功：2026-10-09 13:12:00');
  await expect(state).toContainText('评论整轮最近成功：2026-10-09 13:11:00');
  await expect(state).toContainText('正文最近成功：2026-10-09 13:11:00');
  await expect(state).toContainText('动态图最近成功：2026-10-09 13:12:00');
  await expect(state).toContainText('评论图最近成功：2026-10-09 13:12:00');
  await expect(state).not.toContainText('图片上传失败');
  const complete = (await (await page.request.get(checks)).json()).checks[0];
  expect(complete).toMatchObject({ revision: partial.revision, observed: partial.observed,
    work: 'complete', sync_error: null, media_errors: [], comment_media_errors: [],
    text_last_succeeded_at: partial.text_last_succeeded_at,
    root_comments_last_succeeded_at: partial.root_comments_last_succeeded_at,
    replies_last_succeeded_at: partial.replies_last_succeeded_at });
  const retriedCalls = (await lifecycle.command('calls')).calls.slice(beforeRetry.length);
  expect(retriedCalls.filter(call => ['/x/v2/reply', '/x/v2/reply/reply'].includes(call.path))).toEqual([]);

  await page.getByRole('link', { name: '返回阅读', exact: true }).click();
  await page.getByRole('navigation', { name: '归档范围', exact: true }).getByRole('link', { name: '虚构生命周期作者', exact: true }).click();
  await card.getByRole('link', { name: /^阅读全文 / }).click({ position: { x: 8, y: 8 } });
  await expect(dynamic.getByRole('img')).toHaveCount(2);
  await expect(comment.getByRole('group', { name: '评论图片', exact: true }).getByRole('img')).toHaveCount(2);
  await comment.getByRole('button', { name: '预览图片 2', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '图片预览', exact: true });
  await expect(preview.getByText('2 / 2', { exact: true })).toBeVisible();
  await expect(preview.getByRole('img')).toHaveAttribute('src', /https:\/\/archive-media\.example\.invalid\//);
  await page.keyboard.press('Escape');
  expect(sources.filter(url => url.includes('hdslb.com') || url.includes('source-business'))).toEqual([]);
  expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
});
