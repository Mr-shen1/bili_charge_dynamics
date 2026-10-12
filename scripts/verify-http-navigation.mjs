import assert from 'node:assert/strict';
import { isIP } from 'node:net';
import { chromium, expect } from '@playwright/test';

// 历史阅读/预览回归使用明确的 mock 构建；不冒充生产归档 API 或真机验收。
const baseURL = new URL(process.env.HTTP_ACCEPTANCE_URL || '');
assert.equal(baseURL.protocol, 'http:', 'HTTP_ACCEPTANCE_URL must use real non-localhost HTTP');
assert.equal(isIP(baseURL.hostname), 4, 'Use the actual LAN IPv4 address, not a localhost alias');
assert.match(baseURL.hostname, /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/, 'Use a trusted private LAN address');
assert.equal(baseURL.pathname, '/', 'Use the site root URL');
assert.equal(baseURL.search + baseURL.hash + baseURL.username + baseURL.password, '');
const response = await fetch(baseURL);
assert.equal(response.status, 200);
assert.match(response.headers.get('server') || '', /^nginx\//i, 'Serve the explicit build:mock bundle through real Nginx');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(baseURL.href);
  const capabilities = await page.evaluate(() => ({
    origin: location.origin, isSecureContext,
    randomUUID: typeof crypto.randomUUID, getRandomValues: typeof crypto.getRandomValues,
  }));
  assert.deepEqual(capabilities, {
    origin: baseURL.origin, isSecureContext: false, randomUUID: 'undefined', getRandomValues: 'function',
  }, 'The regression must exercise the real insecure HTTP browser context');
  console.log(`HTTP browser capabilities: ${JSON.stringify(capabilities)}`);
  assert.deepEqual(errors, [], 'The application must start without crypto.randomUUID errors');

  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const metadata = () => page.evaluate(() => history.state?.usr);
  await expect(page.getByRole('article')).toHaveCount(10);
  await expect.poll(metadata).toMatchObject({ sessionId: expect.stringMatching(uuidV4), pageEntryId: expect.stringMatching(uuidV4) });
  const listEntry = await metadata();
  assert.deepEqual(Object.keys(listEntry).sort(), ['pageEntryId', 'sessionId']);
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(20);
  const card = page.getByRole('article').filter({ has: page.getByText('图文日记 6', { exact: false }) });
  await card.getByRole('button', { name: '查看详情', exact: true }).click();
  await expect(page).toHaveURL(new URL('/dynamics/90071992547409936', baseURL).href);
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect.poll(metadata).toMatchObject({ sessionId: listEntry.sessionId, pageEntryId: expect.stringMatching(uuidV4) });
  const detailEntry = await metadata();
  assert.notEqual(detailEntry.pageEntryId, listEntry.pageEntryId);
  assert.deepEqual(Object.keys(detailEntry).sort(), ['pageEntryId', 'sessionId']);

  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '图片预览' });
  await expect(preview.getByText('1 / 12', { exact: true })).toBeVisible();
  await expect.poll(metadata).toMatchObject({ ...detailEntry, previewId: expect.stringMatching(uuidV4) });
  const previewEntry = await metadata();
  assert.deepEqual(Object.keys(previewEntry).sort(), ['pageEntryId', 'previewId', 'sessionId']);
  assert.equal(new Set([listEntry.sessionId, listEntry.pageEntryId, detailEntry.pageEntryId, previewEntry.previewId]).size, 4);
  await preview.getByRole('button', { name: '下一张', exact: true }).click();
  await expect(preview.getByText('2 / 12', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '关闭预览', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect.poll(metadata).toEqual(detailEntry);
  await page.goForward();
  await expect(preview.getByText('2 / 12', { exact: true })).toBeVisible();
  await expect.poll(metadata).toEqual(previewEntry);
  await page.goBack();
  await expect(preview).toHaveCount(0);
  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page).toHaveURL(baseURL.href);
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect.poll(metadata).toEqual(listEntry);

  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(10);
  await expect.poll(metadata).toMatchObject({ sessionId: expect.stringMatching(uuidV4), pageEntryId: expect.stringMatching(uuidV4) });
  const refreshedEntry = await metadata();
  assert.notEqual(refreshedEntry.sessionId, listEntry.sessionId);
  assert.notEqual(refreshedEntry.pageEntryId, listEntry.pageEntryId);
  assert.deepEqual(errors, [], 'Navigation and previews must remain usable over LAN HTTP');
  console.log(`PASS: real Nginx ${baseURL.origin}; UUID v4 session/entries/preview, history restoration and refresh (Chromium ${browser.version()}, not real-device acceptance)`);
} finally {
  await browser.close();
}
