import assert from 'node:assert/strict';
import { cp, readFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';

// mock 和生产构建共用同一发布验证，不重复定义缓存/切换语义。
export async function publishAndVerifyEntryUpdate({
  baseURL, workspace, current, previousBuild, nextBuild, page,
}) {
  const before = await fetch(baseURL);
  const etag = before.headers.get('etag');
  assert(etag, 'Entry has no ETag');
  const previousHTML = await readFile(join(previousBuild, 'index.html'), 'utf8');
  assert.equal(await before.text(), previousHTML);
  const updatedHTML = await readFile(join(nextBuild, 'index.html'), 'utf8');
  const scriptPath = html => {
    const match = html.match(/src="(\/assets\/[^\"]+\.js)"/);
    assert(match, 'Entry has no hashed script');
    return match[1];
  };
  const oldScript = scriptPath(previousHTML);
  const newScript = scriptPath(updatedHTML);
  assert.notEqual(newScript, oldScript);
  // 原子切换入口时仍保留旧哈希，以供已经打开的页面继续读取。
  await cp(join(previousBuild, 'assets'), join(nextBuild, 'assets'), { recursive: true, force: false, errorOnExist: false });
  await symlink(nextBuild, join(workspace, 'next-entry'));
  await rename(join(workspace, 'next-entry'), current);
  const after = await fetch(baseURL, { headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200, 'Changed entry must not return stale 304');
  assert.equal(after.headers.get('cache-control'), 'no-cache');
  assert.equal(await after.text(), updatedHTML);
  for (const path of [oldScript, newScript]) {
    const response = await fetch(`${baseURL}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  }
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.deliveryRevision === 'release-b');
  console.log(`PASS: build update ${oldScript} -> ${newScript}; conditional entry and browser reload use release B`);
}
