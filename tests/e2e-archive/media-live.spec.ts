import { expect, test, type Page } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logsOf, startApi, stopApi } from '../e2e-manage/apiProcess';

const uid = '202';
const dynamicId = '9101';
const factory = { factory: 'live_app:create_app', appDir: 'tests/e2e-archive' };
// 不继承任何真实 OSS 配置；未配置场景也不得触发真实 SDK。
test.beforeAll(() => {
  for (const name of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'ACCESS_KEY_SECRET', 'SECURITY_TOKEN', 'PUBLIC_BASE_URL']) {
    delete process.env[`BILI_OSS_${name}`];
  }
});
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="120"><rect width="80" height="120" fill="cyan"/></svg>';

async function initialize(page: Page) {
  expect((await page.request.post('/api/manage/ups', { data: { uid } })).status()).toBe(201);
  expect((await page.request.patch(`/api/manage/ups/${uid}/monitor`, {
    data: { mode: 'specified', recent_n: 10, enabled: true },
  })).ok()).toBe(true);
  expect((await page.request.post(`/api/manage/ups/${uid}/targets`, { data: { id: dynamicId } })).status()).toBe(201);
  const result = await page.request.post('/api/sync/initial', { data: { uid } });
  expect(result.ok()).toBe(true);
  expect(await result.json()).toEqual({ processed: 1, succeeded: 1, failed: 0 });
}

async function imageBoundary(page: Page) {
  const sources: string[] = [];
  const browserWrites: string[] = [];
  page.on('request', request => {
    if (request.resourceType() === 'image') sources.push(request.url());
    if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) browserWrites.push(request.url());
  });
  // 只替换图片边界：本测试的所有 API 读取均抵达真实 Uvicorn/SQLite。
  await page.route('https://archive-media.example.invalid/**', route =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg }));
  await page.route('https://i0.hdslb.com/**', route => route.abort());
  await page.route('https://example.invalid/**', route => route.abort());
  return { sources, browserWrites };
}

test('实际初始化及独立媒体同步后，列表与预览直接读取完整公开 URL', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'bili-media-live-'));
  const database = join(directory, 'archive.sqlite');
  let api: ChildProcess | undefined;
  try {
    api = await startApi(database, { ...factory, env: { FIXTURE_MEDIA: 'single' } });
    await initialize(page);
    const pending = await page.request.get(`/api/archive/dynamics/${dynamicId}`);
    expect(pending.ok()).toBe(true);
    expect((await pending.json()).media).toMatchObject([{ status: 'pending', public_url: null }]);
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    api = await startApi(database, { ...factory, env: {
      FIXTURE_MEDIA: 'single', FIXTURE_MEDIA_UPLOADER: '1',
    } });
    const synced = await page.request.post(`/api/sync/media/${dynamicId}`);
    expect(synced.ok()).toBe(true);
    expect(await synced.json()).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    const archive = await (await page.request.get(`/api/archive/dynamics/${dynamicId}`)).json();
    expect(archive.media).toMatchObject([{ status: 'success', owner: { type: 'dynamic', id: dynamicId } }]);
    const publicUrl: string = archive.media[0].public_url;
    expect(publicUrl).toMatch(/^https:\/\/archive-media\.example\.invalid\/objects\/.+\.svg$/);

    const { sources, browserWrites } = await imageBoundary(page);
    await page.goto('/');
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    const thumbnail = page.getByRole('img', { name: '图片 1', exact: true });
    await expect(thumbnail).toHaveAttribute('src', publicUrl);
    await expect.poll(() => thumbnail.evaluate(image => image instanceof HTMLImageElement && image.naturalWidth)).toBe(80);
    await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '图片预览' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('1 / 1', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('img', { name: '预览图片 1', exact: true })).toHaveAttribute('src', publicUrl);
    await expect(dialog.getByRole('button', { name: '下一张', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: '预览图片 1', exact: true })).toBeFocused();
    await expect(page).toHaveURL('/');
    const detailLink = page.getByRole('link', { name: `阅读全文 ${dynamicId}`, exact: true });
    await detailLink.focus();
    await detailLink.press('Enter');
    await expect(page).toHaveURL(`/dynamics/${dynamicId}`);
    await expect(page.getByRole('img', { name: '图片 1', exact: true })).toHaveAttribute('src', publicUrl);
    expect(sources).toContain(publicUrl);
    expect(sources.filter(url => url.includes('hdslb.com') || url.includes('source-business') || url.includes('/api/'))).toEqual([]);
    expect(browserWrites).toEqual([]);
    await page.goto('about:blank');
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
  } finally {
    if (api) await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});

test('未上传与上传失败保留原位且不影响正文，断源及删除监控后重开仍可读', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'bili-media-states-'));
  const database = join(directory, 'archive.sqlite');
  let api: ChildProcess | undefined;
  try {
    api = await startApi(database, { ...factory, env: { FIXTURE_MEDIA: 'mixed' } });
    await initialize(page);
    const initial = await (await page.request.get(`/api/archive/dynamics/${dynamicId}`)).json();
    expect(initial.media).toHaveLength(3);
    expect(initial.media).toMatchObject([
      { position: 0, status: 'pending', public_url: null },
      { position: 1, status: 'pending', public_url: null },
      { position: 2, status: 'pending', public_url: null },
    ]);
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    api = await startApi(database, { ...factory, env: { FIXTURE_MEDIA: 'mixed', FIXTURE_MEDIA_UPLOADER: '1' } });
    const outcomes: [number, number, number][] = [[0, 1, 0], [1, 0, 1]];
    for (const [index, succeeded, failed] of outcomes) {
      const synced = await page.request.post(`/api/sync/media/${dynamicId}?media_id=${initial.media[index].id}`);
      expect(synced.ok()).toBe(true);
      expect(await synced.json()).toEqual({ processed: 1, succeeded, failed });
    }
    const archived = await (await page.request.get(`/api/archive/dynamics/${dynamicId}`)).json();
    expect(archived).toMatchObject({ content_state: 'success', last_attempt: 'success', work: { text: 'success', media: 'pending' } });
    expect(archived.media).toMatchObject([
      { id: initial.media[0].id, position: 0, status: 'success' },
      { id: initial.media[1].id, position: 1, status: 'failed', public_url: null, error: 'MEDIA_UPLOAD_FAILED' },
      { id: initial.media[2].id, position: 2, status: 'pending', public_url: null },
    ]);
    expect(JSON.stringify(archived)).not.toContain('FICTIONAL_SECRET');
    const publicUrl: string = archived.media[0].public_url;
    const { sources, browserWrites } = await imageBoundary(page);
    await page.goto(`/dynamics/${dynamicId}`);
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    const group = page.getByRole('group', { name: '动态图片', exact: true });
    await expect(group.getByRole('button', { name: /^预览图片/ })).toHaveCount(3);
    await expect(group.getByRole('img')).toHaveCount(1);
    await expect(group.getByRole('img', { name: '图片 1', exact: true })).toHaveAttribute('src', publicUrl);
    await expect(group.getByRole('button', { name: '预览图片 2', exact: true })).toHaveText('图片归档失败');
    await expect(group.getByRole('button', { name: '预览图片 3', exact: true })).toHaveText('图片待归档');
    await expect(group.getByText('图片加载失败', { exact: true })).toHaveCount(0);
    await group.getByRole('button', { name: '预览图片 2', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '图片预览' });
    await expect(dialog.getByText('2 / 3', { exact: true })).toBeVisible();
    await expect(dialog.getByText('图片归档失败', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('img')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /^重试/ })).toHaveCount(0);
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByText('3 / 3', { exact: true })).toBeVisible();
    await expect(dialog.getByText('图片待归档', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '下一张', exact: true })).toBeDisabled();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.getByText('1 / 3', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('img', { name: '预览图片 1', exact: true })).toHaveAttribute('src', publicUrl);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    expect((await page.request.delete(`/api/manage/ups/${uid}/monitor`)).status()).toBe(204);
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    api = await startApi(database, { ...factory, env: { FIXTURE_MEDIA: 'mixed', FIXTURE_OFFLINE: '1' } });
    await page.reload();
    await expect(page.getByText('虚构首次归档正文', { exact: false })).toBeVisible();
    await expect(group.getByRole('button', { name: '预览图片 2', exact: true })).toHaveText('图片归档失败');
    await expect(group.getByRole('button', { name: '预览图片 3', exact: true })).toHaveText('图片待归档');
    await expect(group.getByRole('img', { name: '图片 1', exact: true })).toHaveAttribute('src', publicUrl);
    const reopened = await (await page.request.get(`/api/archive/dynamics/${dynamicId}`)).json();
    expect(reopened.media).toEqual(archived.media);
    expect(reopened.text).toBe(archived.text);
    expect(reopened.content_state).toBe('success');
    expect(sources).toContain(publicUrl);
    expect(sources.filter(url => url.includes('hdslb.com') || url.includes('source-business') || url.includes('/api/'))).toEqual([]);
    expect(browserWrites).toEqual([]);
    expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
    await page.goto('about:blank');
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
  } finally {
    if (api) await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});

test('实际评论图片 HTTP→Adapter→详情：两个纯图评论组与动态图独立，逐图状态及断源重开保留', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'bili-comment-media-live-'));
  const database = join(directory, 'archive.sqlite');
  const env = { FIXTURE_MEDIA: 'mixed', FIXTURE_ROOT_COMMENTS: '1', FIXTURE_COMMENT_MEDIA: '1' };
  const commentsPath = `/api/archive/dynamics/${dynamicId}/comments`;
  let api: ChildProcess | undefined;
  try {
    api = await startApi(database, { ...factory, env });
    await initialize(page);
    const pending = await (await page.request.get(`${commentsPath}?sort=hot&limit=20`)).json();
    const first = pending.items.find((item: { id: string }) => item.id === '45');
    expect(first.media).toHaveLength(4);
    expect(first.text).toBe('');
    expect(first.media.every((image: { status: string; public_url: string | null }) => image.status === 'pending' && image.public_url === null)).toBe(true);
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    api = await startApi(database, { ...factory, env: { ...env, FIXTURE_MEDIA_UPLOADER: '1' } });
    for (const [index, succeeded, failed] of [[0, 1, 0], [1, 0, 1]] as const) {
      const result = await page.request.post(`/api/sync/media/${dynamicId}/comments/45?media_id=${first.media[index].id}`);
      expect(result.ok()).toBe(true);
      expect(await result.json()).toEqual({ processed: 1, succeeded, failed });
    }
    expect((await page.request.post(`/api/sync/media/${dynamicId}/comments/44`)).ok()).toBe(true);
    const dynamic = await (await page.request.get(`/api/archive/dynamics/${dynamicId}`)).json();
    expect((await page.request.post(`/api/sync/media/${dynamicId}?media_id=${dynamic.media[0].id}`)).ok()).toBe(true);
    const batch = await (await page.request.get(`${commentsPath}?sort=hot&limit=20`)).json();
    const mixed = batch.items.find((item: { id: string }) => item.id === '45');
    const latest = await (await page.request.get(`${commentsPath}?sort=latest&limit=20`)).json();
    const single = latest.items.find((item: { id: string }) => item.id === '44');
    expect(mixed.media).toMatchObject([
      { owner: { type: 'comment', id: '45' }, status: 'success' },
      { status: 'failed', public_url: null, error: 'MEDIA_UPLOAD_FAILED' },
      { status: 'pending', public_url: null }, { status: 'pending', public_url: null },
    ]);
    expect(mixed.media.map((image: { id: string }) => image.id)).toEqual(first.media.map((image: { id: string }) => image.id));
    expect(single.media).toMatchObject([{ owner: { type: 'comment', id: '44' }, status: 'success' }]);
    const { sources, browserWrites } = await imageBoundary(page);
    await page.goto(`/dynamics/${dynamicId}`);
    const row = page.locator('[data-reading-id="comment:45"]');
    const group = row.getByRole('group', { name: '评论图片', exact: true });
    await expect(group.getByRole('button', { name: /^预览图片/ })).toHaveCount(4);
    await expect(row.getByText('暂无评论内容', { exact: true })).toHaveCount(0);
    await expect(group.getByText('图片归档失败', { exact: true })).toBeVisible();
    await expect(group.getByText('图片待归档', { exact: true })).toHaveCount(2);
    const trigger = group.getByRole('button', { name: '预览图片 2', exact: true });
    await trigger.click();
    const preview = page.getByRole('dialog', { name: '图片预览' });
    await expect(preview.getByText('2 / 4', { exact: true })).toBeVisible();
    await expect(preview.getByText('图片归档失败', { exact: true })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(preview.getByRole('img')).toHaveAttribute('src', mixed.media[0].public_url);
    await page.goBack();
    await expect(preview).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.goForward();
    await expect(preview.getByText('1 / 4', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '最新', exact: true }).click();
    const singleTrigger = page.locator('[data-reading-id="comment:44"]').getByRole('button', { name: '预览图片 1', exact: true });
    await singleTrigger.click();
    await expect(preview.getByText('1 / 1', { exact: true })).toBeVisible();
    await expect(preview.getByRole('img')).toHaveAttribute('src', single.media[0].public_url);
    expect(single.media[0].public_url).not.toBe(mixed.media[0].public_url);
    await page.keyboard.press('Escape');
    expect((await page.request.delete(`/api/manage/ups/${uid}/monitor`)).status()).toBe(204);
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
    api = await startApi(database, { ...factory, env: { ...env, FIXTURE_OFFLINE: '1' } });
    await page.reload();
    await expect(group.getByRole('img')).toHaveAttribute('src', mixed.media[0].public_url);
    const reopened = await (await page.request.get(`${commentsPath}?sort=hot&limit=20`)).json();
    expect(reopened.items.find((item: { id: string }) => item.id === '45').media).toEqual(mixed.media);
    expect(sources).toContain(mixed.media[0].public_url);
    expect(sources).toContain(single.media[0].public_url);
    expect(sources.filter(url => url.includes('hdslb.com') || url.includes('source-business') || url.includes('/api/'))).toEqual([]);
    expect(browserWrites).toEqual([]);
    expect(await page.locator('body').innerText()).not.toContain('FICTIONAL_SECRET');
    await page.goto('about:blank');
    await stopApi(api);
    expect(logsOf(api)).not.toContain('FICTIONAL_SECRET');
  } finally {
    if (api) await stopApi(api);
    await rm(directory, { recursive: true, force: true });
  }
});
