// @projects nginx: desktop-chromium, mobile-chromium
import { expect, test } from '@playwright/test';

// 静态交付路径：Nginx 由 scripts/verify-static-delivery.mjs 管理并托管 mock 构建产物，
// 因此只在 E2E_TARGET=nginx 下跑（config 的 testMatch/testIgnore 已限定）；其余装配与设备覆盖见其它 spec。

const revalidate = 'no-cache';
const immutable = 'public, max-age=31536000, immutable';

test('六类页面深链接和带扩展名的页面仍返回重新验证的入口，资源按明确路径分类', async ({ request }) => {
  for (const path of ['/', '/index.html', '/ups/202', '/manage', '/manage/ups/202', '/dynamics/90071992547409934',
    '/dynamics/90071992547409934/comments/root-1',
    // 飞书通知的两条精确入口也必须由静态托管回入口，而不是 404 或 API 代理页。
    '/dynamics/90071992547409934/comments/860001/locate',
    '/dynamics/90071992547409934/comments/860001/replies/960022/locate',
    '/dynamics/id.with.dot', '/unknown.page']) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    expect(response.headers()['cache-control']).toBe(revalidate);
    expect(await response.text()).toContain('<div id="app"></div>');
  }
});

test('入口可通过 ETag 和修改时间重新验证，成功返回 304', async ({ request }) => {
  const entry = await request.get('/');
  for (const [name, value] of [
    ['If-None-Match', entry.headers().etag],
    ['If-Modified-Since', entry.headers()['last-modified']],
  ] as const) {
    expect(value).toBeTruthy();
    const response = await request.get('/', { headers: { [name]: value! } });
    expect(response.status()).toBe(304);
    expect(response.headers()['cache-control']).toBe(revalidate);
    expect(await response.body()).toHaveLength(0);
  }
});

test('入口引用的哈希脚本与样式有正确 MIME 与长期缓存，应用自有图片与头像按未版本化处理', async ({ request }) => {
  const html = await (await request.get('/')).text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1]!);
  expect(assets.some(path => path.endsWith('.js'))).toBe(true);
  expect(assets.some(path => path.endsWith('.css'))).toBe(true);
  for (const path of assets) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe(immutable);
    expect(response.headers()['content-type']).toContain(path.endsWith('.js') ? 'javascript' : 'text/css');
    expect((await response.body()).length).toBeGreaterThan(0);
  }
  // 路由级 chunk 也必须是可长期缓存的哈希资源，入口之外不能出现未版本化 /assets 文件。
  for (const [path, mime] of [
    ['/default-avatar.svg', 'image/svg+xml'],
    ['/images/unavailable/placeholder.svg', 'image/svg+xml'],
  ] as const) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe(revalidate);
    expect(response.headers()['content-type']).toContain(mime);
  }
});

test('缺失脚本样式图片及无扩展名资源返回不可存储的 404，不回退到应用入口', async ({ request }) => {
  for (const path of [
    '/assets/missing.js', '/assets/missing.css', '/assets/no-extension',
    '/images/missing.svg', '/images/unavailable/missing.svg',
    '/default-avatar-missing.svg',
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(404);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(await response.text()).not.toContain('<div id="app"></div>');
  }
});

test('正常产物深链接刷新可看图和返回；页面不存在和内容不存在仍由前端表达', async ({ page }) => {
  const trigger = page.locator('#preview-trigger-dynamic-90071992547409934-0');
  // 应用自有的预览计数是“预览已打开”的公开锚点；不把库内部 DOM 当契约。
  const counter = page.locator('.preview-counter');
  const response = await page.goto('/dynamics/90071992547409934?fault=1');
  expect(response?.status()).toBe(200);
  await trigger.click();
  await expect(counter).toHaveText('1 / 12');
  await page.keyboard.press('Escape');
  await expect(counter).toHaveCount(0);
  await page.reload();
  await expect(trigger).toBeVisible();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('article')).toHaveCount(10);
  const unknown = await page.goto('/unknown.page');
  expect(unknown?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
  const missing = await page.goto('/dynamics/id.with.dot');
  expect(missing?.status()).toBe(200);
  await expect(page.getByText('动态不存在或不可用')).toBeVisible();
  // 精确入口的“目标不存在”与“评论列表顶部”不同：明确提示并保留返回动态入口。
  const locateMissing = await page.goto('/dynamics/90071992547409934/comments/999999/locate');
  expect(locateMissing?.status()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: '目标评论不存在或未归档' })).toBeVisible();
  await page.getByRole('button', { name: '返回动态' }).click();
  await expect(page).toHaveURL('/dynamics/90071992547409934');
  // 用 mock 归档里带 45 条评论、首个根评论有 25 条回复的动态，验证“回复不存在”而不是“根不存在”。
  const replyMissing = await page.goto(
    '/dynamics/90071992547409931/comments/90071992547401001/replies/999999/locate');
  expect(replyMissing?.status()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: '目标回复不存在或未归档' })).toBeVisible();
});
