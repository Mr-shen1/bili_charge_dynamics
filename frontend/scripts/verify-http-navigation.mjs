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

// 应用自有的历史命名空间（与 src/app/historyState.ts 一致）：只存标识与索引，
// 不读写 Vue Router 的私有字段。脚本是无构建步骤的 .mjs，因此按字面量引用。
const entryKey = 'biliChargeDynamicsEntry';
const previewKey = 'biliChargeDynamicsPreview';
const dynamicId = '90071992547409934';

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
  const entryState = () => page.evaluate(key => history.state?.[key] ?? null, entryKey);
  const previewState = () => page.evaluate(key => history.state?.[key] ?? null, previewKey);
  // 应用自有的预览计数与触发元素 id：不依赖 Element Plus 的私有 DOM。
  const counter = page.locator('.preview-counter');

  await expect(page.getByRole('article')).toHaveCount(10);
  await expect.poll(entryState).toMatchObject({ sessionId: expect.stringMatching(uuidV4), pageEntryId: expect.stringMatching(uuidV4) });
  const listEntry = await entryState();
  assert.deepEqual(Object.keys(listEntry).sort(), ['pageEntryId', 'sessionId']);
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(20);

  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: `阅读全文 ${dynamicId}`, exact: true }) });
  await card.getByRole('link', { name: `阅读全文 ${dynamicId}`, exact: true }).click();
  await expect(page).toHaveURL(new URL(`/dynamics/${dynamicId}`, baseURL).href);
  await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
  await expect.poll(entryState).toMatchObject({ sessionId: listEntry.sessionId, pageEntryId: expect.stringMatching(uuidV4) });
  const detailEntry = await entryState();
  assert.notEqual(detailEntry.pageEntryId, listEntry.pageEntryId);
  assert.deepEqual(Object.keys(detailEntry).sort(), ['pageEntryId', 'sessionId']);

  await page.locator(`#preview-trigger-dynamic-${dynamicId}-0`).click();
  await expect(counter).toHaveText('1 / 12');
  await expect.poll(previewState).toMatchObject({ previewId: expect.stringMatching(uuidV4), index: 0 });
  const previewEntry = await previewState();
  assert.deepEqual(Object.keys(previewEntry).sort(), ['groupId', 'index', 'previewId', 'sessionId']);
  assert.equal(previewEntry.groupId, `dynamic-${dynamicId}`);
  assert.deepEqual(await entryState(), detailEntry, '打开预览不得改写底层页面访问标记');
  assert.equal(new Set([
    listEntry.sessionId,
    listEntry.pageEntryId,
    detailEntry.pageEntryId,
    previewEntry.previewId,
  ]).size, 4);

  // 切图只更新当前预览记录，不新增历史条目。
  await page.keyboard.press('ArrowRight');
  await expect(counter).toHaveText('2 / 12');
  await expect.poll(previewState).toMatchObject({ index: 1, previewId: previewEntry.previewId });
  const switchedEntry = await previewState();

  // 浏览器后退优先关闭预览，前进恢复同一张；URL 与底层页面访问保持不变。
  await page.goBack();
  await expect(counter).toHaveCount(0);
  await expect.poll(previewState).toBeNull();
  await expect(page).toHaveURL(new URL(`/dynamics/${dynamicId}`, baseURL).href);
  await page.goForward();
  await expect(counter).toHaveText('2 / 12');
  await expect.poll(previewState).toEqual(switchedEntry);

  // 关闭（Escape 与关闭按钮同走 preview.close）只替换当前记录上的预览标记，不产生第二次后退。
  await page.keyboard.press('Escape');
  await expect(counter).toHaveCount(0);
  await expect.poll(previewState).toBeNull();
  await expect(page).toHaveURL(new URL(`/dynamics/${dynamicId}`, baseURL).href);

  await page.getByRole('button', { name: '返回列表', exact: true }).click();
  await expect(page).toHaveURL(baseURL.href);
  await expect(page.getByRole('article')).toHaveCount(20);
  await expect.poll(entryState).toEqual(listEntry);

  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(10);
  await expect.poll(entryState).toMatchObject({ sessionId: expect.stringMatching(uuidV4), pageEntryId: expect.stringMatching(uuidV4) });
  const refreshedEntry = await entryState();
  assert.notEqual(refreshedEntry.sessionId, listEntry.sessionId);
  assert.notEqual(refreshedEntry.pageEntryId, listEntry.pageEntryId);
  assert.deepEqual(errors, [], 'Navigation and previews must remain usable over LAN HTTP');
  console.log(`PASS: real Nginx ${baseURL.origin}; UUID v4 session/entries/preview, history restoration and refresh (Chromium ${browser.version()}, not real-device acceptance)`);
} finally {
  await browser.close();
}
