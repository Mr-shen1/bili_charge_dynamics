import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_TARGET !== 'nginx', '仅在真实 Nginx 静态交付路径验证 HTTP 行为');

const revalidate = 'no-cache';
const immutable = 'public, max-age=31536000, immutable';

test('四类页面深链接和带扩展名的页面仍返回重新验证的入口，资源按明确路径分类', async ({ request }) => {
  for (const path of ['/', '/index.html', '/ups/202', '/manage', '/dynamics/90071992547409934', '/dynamics/id.with.dot', '/unknown.page']) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    expect(response.headers()['cache-control']).toBe(revalidate);
    expect(await response.text()).toContain('<div id="root"></div>');
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

test('实际入口中的哈希脚本和样式有正确 MIME 与长期缓存，图片缓存区分版本', async ({ request }) => {
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
  for (const [path, cache, mime] of [
    ['/demo-images/landscape-1-thumb.v1.png?signature=demo%2Fonly&expires=123', immutable, 'image/png'],
    ['/demo-images/landscape-1-preview.v1.png', immutable, 'image/png'],
    ['/creator-avatar.v1.svg', immutable, 'image/svg+xml'],
    ['/default-avatar.svg', revalidate, 'image/svg+xml'],
  ] as const) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe(cache);
    expect(response.headers()['content-type']).toContain(mime);
  }
  const unversioned = await request.get('/demo-images/README.md');
  expect(unversioned.status()).toBe(200);
  expect(unversioned.headers()['cache-control']).toBe(revalidate);
});

test('缺失脚本样式图片及无扩展名资源返回不可存储的 404，不回退到应用入口', async ({ request }) => {
  for (const path of [
    '/assets/missing.js', '/assets/missing.css', '/assets/no-extension',
    '/demo-images/missing.v1.png', '/demo-images/missing.png', '/demo-images/no-extension',
    '/creator-avatar.v999.svg', '/default-avatar-missing.svg',
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(404);
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(await response.text()).not.toContain('<div id="root"></div>');
  }
});

test('正常产物深链接刷新可看图和返回；页面不存在和内容不存在仍由前端表达', async ({ page }) => {
  const response = await page.goto('/dynamics/90071992547409934?fault=1');
  expect(response?.status()).toBe(200);
  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '图片预览' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('button', { name: '预览图片 1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('article')).toHaveCount(10);
  const unknown = await page.goto('/unknown.page');
  expect(unknown?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '未找到页面' })).toBeVisible();
  const missing = await page.goto('/dynamics/id.with.dot');
  expect(missing?.status()).toBe(200);
  await expect(page.getByText('动态不存在')).toBeVisible();
});
