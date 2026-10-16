import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

// 只替换外部图片传输；页面、API Adapter、HTTP 和 SQLite 均是真实装配。
export async function verifyProductionDelivery(baseURL, buildDir, secret) {
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
      for (const path of ['/', `/ups/${uid}`, `/dynamics/${dynamicId}`, '/manage']) {
        const response = await page.goto(`${baseURL}${path}?fault=1`);
        assert.equal(response.status(), 200);
        assert.equal(response.headers()['cache-control'], 'no-cache');
        const expected = path === '/manage' ? '监控管理' : '部署隔离正文';
        await page.getByText(expected, { exact: false }).first().waitFor();
        await page.reload();
        await page.getByText(expected, { exact: false }).first().waitFor();
        assert(!(await page.content()).includes(secret), 'UI leaked the fixture secret');
      }
      await page.goto(`${baseURL}/dynamics/${dynamicId}`);
      await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
      await page.getByRole('dialog', { name: '图片预览' }).waitFor();
      assert(requests.some(request => request.url === imageURL), 'Business image was not fetched from its public URL');
      await page.goto(`${baseURL}/unknown.page`);
      await page.getByRole('heading', { name: '未找到页面' }).waitFor();
      await page.reload();
      await page.getByRole('heading', { name: '未找到页面' }).waitFor();
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
      ['/assets/missing.js', 404], ['/assets/no-extension', 404],
    ]) {
      const response = await fetch(`${baseURL}${path}`);
      assert.equal(response.status, status, path);
      assert.equal(response.headers.get('cache-control'), 'no-store', path);
      const body = await response.text();
      assert(!body.includes('<div id="root">'), path);
      assert(!body.includes(secret), 'HTTP leaked the fixture secret');
      if (path.startsWith('/api')) assert(response.headers.get('content-type').includes('application/json'));
    }
    const html = await (await fetch(baseURL)).text();
    assert.equal(html, await readFile(join(buildDir, 'index.html'), 'utf8'));
    for (const name of await readdir(join(buildDir, 'assets'))) {
      const content = await readFile(join(buildDir, 'assets', name), 'utf8');
      assert(!content.includes(secret), 'Build leaked the fixture secret');
      assert(!content.includes('90071992547409934'), 'Historical mock data entered the production bundle');
      assert(!content.includes('failFirstList'), 'Fault assembly entered the production bundle');
    }
    console.log('PASS: production Adapter, four deep links/reloads, public images, read-only browsing, API/resource errors and secret scan');
  } finally {
    await browser.close();
  }
}
