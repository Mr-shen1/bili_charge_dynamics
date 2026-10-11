import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';

// 只在临时目录启动 Nginx，不 reload 系统服务，也不修改源文件或真实发布目录。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nginxBin = process.env.NGINX_BIN || 'nginx';
const mimeTypes = process.env.NGINX_MIME_TYPES;
assert(mimeTypes, 'Set NGINX_MIME_TYPES to an existing Nginx mime.types file');
await readFile(mimeTypes);

function run(command, args, cwd = repo, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}

async function assertSameBuild(expected, actual) {
  assert.equal(await readFile(join(actual, 'index.html'), 'utf8'), await readFile(join(expected, 'index.html'), 'utf8'));
  const assets = (await readdir(join(expected, 'assets'))).sort();
  assert.deepEqual((await readdir(join(actual, 'assets'))).sort(), assets);
  for (const name of assets) {
    assert.deepEqual(await readFile(join(actual, 'assets', name)), await readFile(join(expected, 'assets', name)));
  }
}

// 不占用已有服务；测试端口与现有 Playwright 浏览器接缝一致。
const probe = createServer();
probe.listen(4173, '127.0.0.1');
await once(probe, 'listening');
await new Promise((accept, reject) => probe.close(error => error ? reject(error) : accept()));
run(nginxBin, ['-v']);
run('pnpm', ['build']);

const workspace = await mkdtemp(join(tmpdir(), 'dynamics-static-'));
let nginx;
let browser;
try {
  const releaseA = join(workspace, 'release-a');
  const releaseB = join(workspace, 'build-source', 'dist');
  const current = join(workspace, 'current');
  await cp(join(repo, 'dist'), releaseA, { recursive: true });
  await symlink(releaseA, current);
  // Nginx 解析 error_log stderr 之前仍会打开默认 logs/error.log；避免启动 alert。
  await mkdir(join(workspace, 'logs'));
  const quote = path => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const serverBlock = (await readFile(join(repo, 'deploy/nginx.conf'), 'utf8'))
    .replace('/srv/dynamics-viewer/current', quote(current));
  await writeFile(join(workspace, 'server.conf'), serverBlock);
  const config = join(workspace, 'nginx.conf');
  await writeFile(config, `pid nginx.pid;
error_log stderr;
events {}
http {
  include ${quote(resolve(mimeTypes))};
  default_type application/octet-stream;
  access_log off;
  include ${quote(join(workspace, 'server.conf'))};
}
`);
  run(nginxBin, ['-t', '-p', `${workspace}/`, '-c', config]);
  nginx = spawn(nginxBin, ['-p', `${workspace}/`, '-c', config, '-g', 'daemon off;'], { stdio: 'inherit' });
  let startupError;
  nginx.on('error', error => { startupError = error; });
  const baseURL = 'http://127.0.0.1:4173';
  const originalEntry = await readFile(join(releaseA, 'index.html'), 'utf8');
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    assert.equal(nginx.exitCode, null, 'Nginx exited before readiness');
    try {
      const response = await fetch(baseURL, { signal: AbortSignal.timeout(500) });
      ready = response.ok && await response.text() === originalEntry;
    } catch { /* 等待本次启动的 Nginx，超时后失败。 */ }
    if (ready) break;
    await delay(50);
  }
  assert(ready, 'Nginx did not serve release A');
  run('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], repo, {
    ...process.env, E2E_TARGET: 'nginx',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  });

  // 从同一输入在独立临时目录再构建，核对静态入口及 bundle 的确定性。
  const buildSource = join(workspace, 'build-source');
  await mkdir(buildSource);
  for (const path of ['src', 'public', 'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) {
    await cp(join(repo, path), join(buildSource, path), { recursive: true });
  }
  await symlink(join(repo, 'node_modules'), join(buildSource, 'node_modules'), 'dir');
  run('pnpm', ['build'], buildSource);
  await assertSameBuild(releaseA, releaseB);
  // 即使显式指定 fault 构建模式，也不能把开发故障装配带入发布产物。
  run('pnpm', ['build', '--mode', 'fault'], buildSource);
  await assertSameBuild(releaseA, releaseB);
  console.log('PASS: reproducible bundles; fault build mode still uses normal assembly');

  // 仅修改临时副本，再真实构建 B：不是手改 dist 或伪造新资源名。
  const mainPath = join(buildSource, 'src/main.tsx');
  await writeFile(mainPath, `${await readFile(mainPath, 'utf8')}\ndocument.documentElement.dataset.deliveryRevision = 'release-b';\n`);
  const entryPath = join(buildSource, 'index.html');
  await writeFile(entryPath, (await readFile(entryPath, 'utf8')).replace('</title>', ' — delivery update</title>'));
  run('pnpm', ['build'], buildSource);
  const updatedEntry = await readFile(join(releaseB, 'index.html'), 'utf8');
  const scriptPath = html => {
    const match = html.match(/src="(\/assets\/[^\"]+\.js)"/);
    assert(match, 'Entry has no hashed script');
    return match[1];
  };
  const oldScript = scriptPath(originalEntry);
  const newScript = scriptPath(updatedEntry);
  assert.notEqual(newScript, oldScript);
  // 保留旧哈希资源，避免切换时已打开页面的后续请求失效。
  await cp(join(releaseA, 'assets'), join(releaseB, 'assets'), { recursive: true, force: false, errorOnExist: false });
  const before = await fetch(baseURL);
  const etag = before.headers.get('etag');
  assert(etag, 'Entry has no ETag');
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${baseURL}/dynamics/90071992547409934`);
  await page.getByRole('button', { name: '预览图片 1', exact: true }).waitFor();
  await symlink(releaseB, join(workspace, 'next'));
  await rename(join(workspace, 'next'), current);
  const after = await fetch(baseURL, { headers: { 'If-None-Match': etag } });
  assert.equal(after.status, 200, 'Changed entry must not return stale 304');
  assert.equal(after.headers.get('cache-control'), 'no-cache');
  assert.equal(await after.text(), updatedEntry);
  for (const path of [oldScript, newScript]) {
    const response = await fetch(`${baseURL}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  }
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.deliveryRevision === 'release-b');
  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  await page.getByRole('dialog', { name: '图片预览' }).waitFor();
  console.log(`PASS: build update ${oldScript} -> ${newScript}; conditional entry and browser reload use release B`);
} finally {
  await browser?.close();
  if (nginx && nginx.exitCode === null && nginx.signalCode === null) {
    const stopped = once(nginx, 'exit');
    nginx.kill('SIGQUIT');
    const forceStop = setTimeout(() => nginx.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(forceStop);
  }
  await rm(workspace, { recursive: true, force: true });
}
