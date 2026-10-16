import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { deliveryEnv, verifyProductionDeployment } from './verify-production-deployment.mjs';
import { publishAndVerifyEntryUpdate } from './verify-entry-update.mjs';

// 只在临时目录启动 Nginx，不 reload 系统服务，也不修改源文件或真实发布目录。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nginxBin = process.env.NGINX_BIN || 'nginx';
const mimeTypes = process.env.NGINX_MIME_TYPES;
assert(mimeTypes, 'Set NGINX_MIME_TYPES to an existing Nginx mime.types file');
await readFile(mimeTypes);

function run(command, args, cwd = repo, env = deliveryEnv) {
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
// 使用空闲回环端口，不复用或停止维护者已有的 API。
const apiProbe = createServer();
apiProbe.listen(0, '127.0.0.1');
await once(apiProbe, 'listening');
const apiPort = apiProbe.address().port;
await new Promise((accept, reject) => apiProbe.close(error => error ? reject(error) : accept()));
let nginx;
let nginxLogs = '';
let browser;
try {
  const releaseA = join(workspace, 'release-a');
  const releaseB = join(workspace, 'build-source', 'dist');
  const current = join(workspace, 'current');
  const productionBuild = join(workspace, 'production-build');
  await cp(join(repo, 'dist'), productionBuild, { recursive: true });
  // 历史阅读回归使用显式 mock 构建；它不能替代生产 API 验收证据。
  run('pnpm', ['build:mock']);
  await cp(join(repo, 'dist'), releaseA, { recursive: true });
  await symlink(releaseA, current);
  // Nginx 解析 error_log stderr 之前仍会打开默认 logs/error.log；避免启动 alert。
  await mkdir(join(workspace, 'logs'));
  const quote = path => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const serverBlock = (await readFile(join(repo, 'deploy/nginx.conf'), 'utf8'))
    .replace('/srv/dynamics-viewer/current', quote(current))
    .replaceAll('127.0.0.1:8000', `127.0.0.1:${apiPort}`);
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
  nginx = spawn(nginxBin, ['-p', `${workspace}/`, '-c', config, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [nginx.stdout, nginx.stderr]) stream.on('data', chunk => { nginxLogs += String(chunk); });
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
    ...deliveryEnv, E2E_TARGET: 'nginx',
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
  await assertSameBuild(productionBuild, releaseB);
  // 即使显式指定 fault 构建模式，也不能把开发故障装配带入发布产物。
  run('pnpm', ['build', '--mode', 'fault'], buildSource);
  await assertSameBuild(productionBuild, releaseB);
  run('pnpm', ['build:mock'], buildSource);
  await assertSameBuild(releaseA, releaseB);
  console.log('PASS: 生产与显式 mock bundle 构建可复现；fault 构建仍使用 production 装配');

  // 仅修改临时副本，再真实构建 B：不是手改 dist 或伪造新资源名。
  const mainPath = join(buildSource, 'src/main.tsx');
  await writeFile(mainPath, `${await readFile(mainPath, 'utf8')}\ndocument.documentElement.dataset.deliveryRevision = 'release-b';\n`);
  const entryPath = join(buildSource, 'index.html');
  await writeFile(entryPath, (await readFile(entryPath, 'utf8')).replace('</title>', ' — delivery update</title>'));
  run('pnpm', ['build:mock'], buildSource);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${baseURL}/dynamics/90071992547409934`);
  await page.getByRole('button', { name: '预览图片 1', exact: true }).waitFor();
  await publishAndVerifyEntryUpdate({
    baseURL, workspace, current, previousBuild: releaseA, nextBuild: releaseB, page,
  });
  await page.getByRole('button', { name: '预览图片 1', exact: true }).click();
  await page.getByRole('dialog', { name: '图片预览' }).waitFor();
  await browser.close();
  browser = undefined;
  await verifyProductionDeployment({
    repo, workspace, current, productionBuild, buildSource, apiPort, baseURL,
    nginxLogs: () => nginxLogs,
  });
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
  // 不要让显式演示 bundle 留在默认发布目录。
  run('pnpm', ['build']);
}
