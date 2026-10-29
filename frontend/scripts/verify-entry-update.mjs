import assert from 'node:assert/strict';
import { cp, readFile, readdir, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { HASHED_ASSET, MIN_ROUTE_CHUNKS, routeChunkNames } from './lib/build-assets.mjs';

// mock 和生产构建共用同一发布验证，不重复定义缓存/切换语义。
const immutable = 'public, max-age=31536000, immutable';

// 入口引用的全部哈希资源：脚本、样式以及可能出现的 modulepreload。
// 不假设入口只有一个 <script>，否则拆包或加预加载后探测会静默漏掉资源。
function referencedAssets(html) {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]))].sort();
}

function entryScript(html) {
  const match = html.match(/<script[^>]+src="(\/assets\/[^"]+\.js)"/);
  assert(match, 'Entry has no hashed script');
  return match[1];
}

function expectedContentType(path) {
  if (path.endsWith('.js')) return 'javascript';
  if (path.endsWith('.css')) return 'text/css';
  return null;
}

async function assertAssetServed(baseURL, path) {
  const response = await fetch(`${baseURL}${path}`);
  assert.equal(response.status, 200, `${path} must stay reachable`);
  assert.equal(response.headers.get('cache-control'), immutable, `${path} must stay immutable`);
  const contentType = expectedContentType(path);
  if (contentType) {
    assert((response.headers.get('content-type') ?? '').includes(contentType), `${path} content type`);
  }
}

/** 逐个验证入口引用资源；新旧入口的脚本、样式和预加载都要仍然可达。 */
export async function assertEntryAssets(baseURL, ...htmls) {
  const refs = [...new Set(htmls.flatMap(referencedAssets))].sort();
  assert(refs.some(path => path.endsWith('.js')), 'Entry references no hashed script');
  assert(refs.some(path => path.endsWith('.css')), 'Entry references no hashed stylesheet');
  for (const path of refs) await assertAssetServed(baseURL, path);
  return refs;
}

/**
 * 验证构建产物里每个哈希资源都能经 Nginx 取到，而不只看入口脚本。
 * 路由级 chunk、共享 chunk 和 CSS 只在导航时按需加载，入口 HTML 不会引用它们。
 */
export async function assertEveryBuiltAsset(baseURL, buildDir) {
  const assets = (await readdir(join(buildDir, 'assets'))).sort();
  assert(assets.length > 0, 'Build has no hashed assets');
  const unhashed = assets.filter(name => !HASHED_ASSET.test(name));
  assert.deepEqual(unhashed, [], `/assets/ 只能放内容哈希文件：${unhashed.join(', ')}`);
  const routeChunks = routeChunkNames(assets);
  assert(routeChunks.length >= MIN_ROUTE_CHUNKS,
    `路由级 chunk 少于六条路由：${routeChunks.join(', ') || '无'}`);
  for (const name of assets) await assertAssetServed(baseURL, `/assets/${name}`);
  return { assets, routeChunks };
}

async function switchCurrent({ workspace, current, next, label }) {
  await symlink(next, join(workspace, `${label}-next`));
  await rename(join(workspace, `${label}-next`), current);
}

export async function publishAndVerifyEntryUpdate({
  baseURL, workspace, current, previousBuild, nextBuild, page,
}) {
  const before = await fetch(baseURL);
  const etag = before.headers.get('etag');
  assert(etag, 'Entry has no ETag');
  const previousHTML = await readFile(join(previousBuild, 'index.html'), 'utf8');
  assert.equal(await before.text(), previousHTML);
  const updatedHTML = await readFile(join(nextBuild, 'index.html'), 'utf8');
  const oldScript = entryScript(previousHTML);
  const newScript = entryScript(updatedHTML);
  assert.notEqual(newScript, oldScript);
  assert(referencedAssets(previousHTML).some(path => path.endsWith('.css')), 'Previous entry references no stylesheet');
  assert(referencedAssets(updatedHTML).some(path => path.endsWith('.css')), 'Updated entry references no stylesheet');

  // 原子切换入口时仍保留旧哈希，以供已经打开的页面继续读取脚本、样式与懒加载 chunk。
  await cp(join(previousBuild, 'assets'), join(nextBuild, 'assets'), { recursive: true, force: false, errorOnExist: false });
  await switchCurrent({ workspace, current, next: nextBuild, label: 'update' });
  const after = await fetch(baseURL, { headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200, 'Changed entry must not return stale 304');
  assert.equal(after.headers.get('cache-control'), 'no-cache');
  assert.equal(await after.text(), updatedHTML);
  const refs = await assertEntryAssets(baseURL, previousHTML, updatedHTML);
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.deliveryRevision === 'release-b');
  console.log(`PASS: build update ${oldScript} -> ${newScript}; 新旧入口引用资源（共 ${refs.length} 个）均可达，浏览器加载 release B`);
  return { previousHTML, updatedHTML };
}

/**
 * 回退演练：把 current 指回上一版产物，同时保留新版哈希资源。
 * 只切前端产物；调用方负责证明数据库与 collector 未被回退或重启。
 */
export async function rollbackAndVerify({
  baseURL, workspace, current, previousBuild, nextBuild, page, navigate,
}) {
  const before = await fetch(baseURL);
  const etag = before.headers.get('etag');
  assert(etag, 'Updated entry has no ETag');
  const updatedHTML = await readFile(join(nextBuild, 'index.html'), 'utf8');
  assert.equal(await before.text(), updatedHTML);
  const previousHTML = await readFile(join(previousBuild, 'index.html'), 'utf8');
  // 回退不能删掉新版哈希文件：回退前已经打开的页面仍在用它们。
  await cp(join(nextBuild, 'assets'), join(previousBuild, 'assets'), { recursive: true, force: false, errorOnExist: false });
  await switchCurrent({ workspace, current, next: previousBuild, label: 'rollback' });
  const after = await fetch(baseURL, { headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200, 'Rolled-back entry must not return the updated 304');
  assert.equal(after.headers.get('cache-control'), 'no-cache');
  assert.equal(await after.text(), previousHTML);
  const refs = await assertEntryAssets(baseURL, previousHTML, updatedHTML);
  const failedAssets = [];
  const onResponse = response => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/assets/') && response.status() >= 400) failedAssets.push(`${response.status()} ${path}`);
  };
  page.on('response', onResponse);
  try {
    if (navigate) await navigate(page);
  } finally {
    page.off('response', onResponse);
  }
  assert.deepEqual(failedAssets, [], '回退后导航不得请求到 4xx 哈希资源');
  // 04 起标签标题由路由决定（不再是入口 HTML 的静态标题），不能再用标题当产物身份。
  // 这里用「release B 的构建标记消失」+「应用真的挂载」正向证明浏览器回到了旧产物，
  // 而不是只断言新构建的标记消失（后者在页面根本没加载时也成立）；
  // 入口 HTML 本身已在上文按字节与旧产物比较过。
  const previousScript = entryScript(previousHTML);
  const updatedScript = entryScript(updatedHTML);
  await page.reload();
  await page.waitForFunction(() => (document.getElementById('app')?.childElementCount ?? 0) > 0
    && document.documentElement.dataset.deliveryRevision === undefined);
  console.log(`PASS: 回退到旧入口；旧/新入口引用资源（共 ${refs.length} 个）仍可达，`
    + `页面重新加载旧产物 ${previousScript} 并完成挂载（不含 ${updatedScript}）`);
  return { previousHTML, updatedHTML };
}
