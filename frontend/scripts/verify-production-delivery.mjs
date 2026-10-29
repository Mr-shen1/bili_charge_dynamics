import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { assertEveryBuiltAsset } from './verify-entry-update.mjs';

// 只替换外部图片传输；页面、API Adapter、HTTP 和 SQLite 均是真实装配。
export async function verifyProductionDelivery(baseURL, buildDir, secret, { authBaseURL } = {}) {
  const uid = '202';
  const dynamicId = '91001';
  const imageURL = 'https://media.example.invalid/deployment.png';
  const browser = await chromium.launch();
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const requests = [];
      const errors = [];
      page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://media.example.invalid/**', route => route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="cyan"/></svg>',
      }));
      // 六条正式路由逐条直达并刷新；每条只在自身区域断言锚点，不依赖其它页面的数据。
      const routes = [
        { path: '/', anchor: () => page.getByText('部署隔离正文', { exact: false }).first() },
        { path: `/ups/${uid}`, anchor: () => page.getByText('部署隔离正文', { exact: false }).first() },
        { path: `/dynamics/${dynamicId}`, anchor: () => page.getByText('部署隔离正文', { exact: false }).first() },
        { path: `/dynamics/${dynamicId}/comments/91002`, anchor: () => page.getByRole('button', { name: '返回评论' }) },
        // 会话页身份含动态、根评论与入口回复：直达/刷新由 SPA 回退提供壳，读取仍只走只读接口。
        {
          path: `/dynamics/${dynamicId}/comments/91002/replies/91002/conversation`,
          anchor: () => page.getByText('‹ 会话列表'),
        },
        { path: '/manage', anchor: () => page.getByRole('link', { name: `管理 UP ${uid}` }) },
        { path: `/manage/ups/${uid}`, anchor: () => page.getByRole('heading', { name: '指定动态目标' }) },
      ];
      for (const route of routes) {
        const response = await page.goto(`${baseURL}${route.path}?fault=1`);
        assert.equal(response.status(), 200, route.path);
        assert.equal(response.headers()['cache-control'], 'no-cache', route.path);
        await route.anchor().waitFor();
        await page.reload();
        await route.anchor().waitFor();
        assert(!(await page.content()).includes(secret), 'UI leaked the fixture secret');
      }
      await page.goto(`${baseURL}/dynamics/${dynamicId}`);
      await page.locator(`#preview-trigger-dynamic-${dynamicId}-0`).click();
      await page.locator('.preview-counter').waitFor();
      assert(requests.some(request => request.url === imageURL), 'Business image was not fetched from its public URL');
      await page.goto(`${baseURL}/unknown.page`);
      await page.getByRole('heading', { name: '页面不存在' }).waitFor();
      await page.reload();
      await page.getByRole('heading', { name: '页面不存在' }).waitFor();
      const apiRequests = requests.filter(request => new URL(request.url).pathname.startsWith('/api'));
      assert(apiRequests.some(request => request.url.includes('/api/archive/dynamics')), 'Production Adapter did not read the API');
      assert(apiRequests.every(request => request.method === 'GET'), 'Browsing implicitly triggered a write or collection');
      assert(!requests.some(request => /(?:api\.bilibili\.com|www\.bilibili\.com|hdslb\.com|biliimg\.com)/.test(new URL(request.url).hostname)), 'Browser requested the source');
      assert.deepEqual(errors, []);
      await page.close();
    }
    for (const [path, status] of [
      ['/api/manage/ups', 200], ['/api', 404], ['/api/no-such-route', 404],
      ['/api/archive/dynamics/99999', 404], ['/api/archive/dynamics?limit=0', 422],
      // 通知精确入口的只读定位接口同样不走 SPA 回退：错误保持 JSON 与 no-store。
      ['/api/archive/dynamics/91001/comments/999999/location', 404],
      ['/assets/missing.js', 404], ['/assets/no-extension', 404],
    ]) {
      const response = await fetch(`${baseURL}${path}`);
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      const body = await response.text();
      assert(!body.includes('<div id="app">'), path);
      assert(!body.includes(secret), 'HTTP leaked the fixture secret');
      if (path.startsWith('/api')) assert(response.headers.get('content-type').includes('application/json'));
    }
    // 入口脚本之外的拆包资源、CSS 与懒加载 chunk 也要逐个可达，不能只探测单个入口。
    const { assets } = await assertEveryBuiltAsset(baseURL, buildDir);
    const html = await (await fetch(baseURL)).text();
    assert.equal(html, await readFile(join(buildDir, 'index.html'), 'utf8'));
    for (const name of await readdir(join(buildDir, 'assets'))) {
      const content = await readFile(join(buildDir, 'assets', name), 'utf8');
      assert(!content.includes(secret), 'Build leaked the fixture secret');
      assert(!content.includes('90071992547409934'), 'Historical mock data entered the production bundle');
      assert(!content.includes('mock-archive:'), 'Mock assembly entered the production bundle');
      assert(!content.includes('/images/full/'), 'Fixture image addresses entered the production bundle');
    }
    if (authBaseURL) {
      // 隔离的受保护反代：只有 /api/manage/ 需要身份验证，页面本身可加载，
      // 用于证明管理 401 提示与“代理错误不回退 SPA”在真实 Nginx 下仍然成立。
      const unauthorized = await fetch(`${authBaseURL}/api/manage/ups`);
      assert.equal(unauthorized.status, 401, 'Protected API must answer 401');
      assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
      assert.match(unauthorized.headers.get('www-authenticate') ?? '', /^Basic /, 'Proxy must keep its Basic challenge');
      const unauthorizedBody = await unauthorized.text();
      assert(!unauthorizedBody.includes('<div id="app">'), 'Proxy 401 must not fall back to the SPA entry');
      assert(!unauthorizedBody.includes(secret), 'Proxy 401 leaked the fixture secret');
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      try {
        const entry = await page.goto(`${authBaseURL}/manage`);
        assert.equal(entry.status(), 200, 'Page shell stays loadable; only the API is protected');
        assert.equal(entry.headers()['cache-control'], 'no-cache');
        // 401 提示按管理区块分别出现（通知区块与目标区块各自读取）：断言"有该提示、无新增表单"，
        // 不对提示条数做假设。
        await page.getByRole('alert').filter({ hasText: '管理访问需要身份验证' }).first().waitFor();
        await page.getByRole('button', { name: '重新读取', exact: true }).first().waitFor();
        assert.equal(await page.getByRole('textbox', { name: 'UP UID' }).count(), 0, '401 must not expose the add form');
      } finally {
        await page.close();
      }
    }
    console.log(`PASS: production Adapter, 六条路由 direct/reload, ${assets.length} 个哈希资源可达, public images, read-only browsing, API/resource errors, 401 prompt and secret scan`);
  } finally {
    await browser.close();
  }
}
