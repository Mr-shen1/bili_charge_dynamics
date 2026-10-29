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
import { publishAndVerifyEntryUpdate, rollbackAndVerify, assertEveryBuiltAsset } from './verify-entry-update.mjs';

// 只在临时目录启动 Nginx，不 reload 系统服务，也不修改源文件或真实发布目录。
// 脚本位于 frontend/scripts：app 是前端应用根（构建与用例），repo 是仓库根（部署配置与后端夹具）。
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '..');
const nginxBin = process.env.NGINX_BIN || 'nginx';
const mimeTypes = process.env.NGINX_MIME_TYPES;
assert(mimeTypes, 'Set NGINX_MIME_TYPES to an existing Nginx mime.types file');
await readFile(mimeTypes);

function run(command, args, cwd = app, env = deliveryEnv) {
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

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((accept, reject) => probe.close(error => error ? reject(error) : accept()));
  return port;
}

async function assertPortFree(port) {
  const probe = createServer();
  try {
    probe.listen(port, '127.0.0.1');
    await once(probe, 'listening');
  } catch (error) {
    throw new Error(`127.0.0.1:${port} 已被占用（${error.code}）；用 DELIVERY_PORT 指定其它端口，不要停止现有实例或隧道`);
  } finally {
    if (probe.listening) await new Promise(accept => probe.close(() => accept()));
  }
}

// 不占用已有服务；测试端口与现有 Playwright 浏览器接缝一致。
// 默认 4173 与交付示例一致；本机已有实例或隧道占用时用 DELIVERY_PORT 换端口，仍不动现有实例。
const port = Number(process.env.DELIVERY_PORT || 4173);
assert(Number.isInteger(port) && port > 0 && port < 65536, 'DELIVERY_PORT must be a TCP port');
const authPort = await freePort();
const baseURL = `http://127.0.0.1:${port}`;
const authBaseURL = `http://127.0.0.1:${authPort}`;
await assertPortFree(port);
run(nginxBin, ['-v']);
run('pnpm', ['build']);

const workspace = await mkdtemp(join(tmpdir(), 'dynamics-static-'));
// 使用空闲回环端口，不复用或停止维护者已有的 API。
const apiPort = await freePort();
let nginx;
let nginxLogs = '';
let browser;
try {
  const releaseA = join(workspace, 'release-a');
  // 更新演练两侧必须是同一种装配：release B 由改动后的 mock 源码重新构建得到。
  const releaseB = join(workspace, 'build-source', 'dist-mock');
  const reproducedProduction = join(workspace, 'build-source', 'dist');
  const current = join(workspace, 'current');
  const productionBuild = join(workspace, 'production-build');
  await cp(join(app, 'dist'), productionBuild, { recursive: true });
  // 历史阅读回归使用显式 mock 构建；它不能替代生产 API 验收证据。
  // Vue 应用把自检构建输出到独立目录，生产 dist 不被覆盖。
  run('pnpm', ['build:mock']);
  await cp(join(app, 'dist-mock'), releaseA, { recursive: true });
  await symlink(releaseA, current);
  // Nginx 解析 error_log stderr 之前仍会打开默认 logs/error.log；避免启动 alert。
  await mkdir(join(workspace, 'logs'));
  const quote = path => `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const serverBlock = (await readFile(join(repo, 'deploy/nginx.conf'), 'utf8'))
    .replace('listen 127.0.0.1:4173;', `listen 127.0.0.1:${port};`)
    .replace('/srv/dynamics-viewer/current', quote(current))
    .replaceAll('127.0.0.1:8000', `127.0.0.1:${apiPort}`);
  await writeFile(join(workspace, 'server.conf'), serverBlock);
  // 仅隔离验证用的第二个 server：模拟 ECS 反代对管理 API 的 Basic 保护。
  // 页面本身不拦截，以便观察前端在真实代理 401 时的固定提示；密码哈希只需格式合法。
  const htpasswd = join(workspace, 'htpasswd');
  await writeFile(htpasswd, 'fixture:$apr1$isolated$0123456789abcdefghijkl\n');
  const authBlock = serverBlock
    .replace(`listen 127.0.0.1:${port};`, `listen 127.0.0.1:${authPort};`)
    .replace('    location ^~ /api/ {', `    location ^~ /api/manage/ {
        auth_basic "isolated-delivery";
        auth_basic_user_file ${quote(htpasswd)};
        proxy_pass http://127.0.0.1:${apiPort};
        proxy_set_header Host $host;
        proxy_intercept_errors off;
        add_header Cache-Control "no-store" always;
    }

    location ^~ /api/ {`);
  assert.notEqual(authBlock, serverBlock, 'Auth probe server block was not generated');
  // 只换端口也会让两者不等，必须确认鉴权块真的注入到了受保护 server。
  assert(authBlock.includes('auth_basic "isolated-delivery"'), '受保护反代的 auth_basic 未注入');
  assert(!serverBlock.includes('auth_basic'), '基准 server 不应带鉴权');
  await writeFile(join(workspace, 'server-auth.conf'), authBlock);
  const config = join(workspace, 'nginx.conf');
  await writeFile(config, `pid nginx.pid;
error_log stderr;
events {}
http {
  include ${quote(resolve(mimeTypes))};
  default_type application/octet-stream;
  access_log off;
  include ${quote(join(workspace, 'server.conf'))};
  include ${quote(join(workspace, 'server-auth.conf'))};
}
`);
  run(nginxBin, ['-t', '-p', `${workspace}/`, '-c', config]);
  nginx = spawn(nginxBin, ['-p', `${workspace}/`, '-c', config, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [nginx.stdout, nginx.stderr]) stream.on('data', chunk => { nginxLogs += String(chunk); });
  let startupError;
  nginx.on('error', error => { startupError = error; });
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
  // 显式 mock 产物也要逐个哈希资源可达（含两个自检页 chunk），不只验入口单脚本。
  const mockAssets = await assertEveryBuiltAsset(baseURL, releaseA);
  console.log(`PASS: mock 产物 ${mockAssets.assets.length} 个哈希资源可达，路由 chunk ${mockAssets.routeChunks.length} 个`);
  console.log(`=== 阶段 1/3：显式 mock 构建的阅读/缓存/404/构建复现与发布回退（${baseURL}） ===`);
  run('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], app, {
    ...deliveryEnv, E2E_TARGET: 'nginx', E2E_NGINX_BASE: baseURL,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  });

  // 从同一输入在独立临时目录再构建，核对静态入口及 bundle 的确定性。
  const buildSource = join(workspace, 'build-source');
  await mkdir(buildSource);
  for (const path of ['src', 'public', 'package.json', 'tsconfig.json', 'vite.config.ts', 'index.html']) {
    await cp(join(app, path), join(buildSource, path), { recursive: true });
  }
  await symlink(join(app, 'node_modules'), join(buildSource, 'node_modules'), 'dir');
  run('pnpm', ['build'], buildSource);
  await assertSameBuild(productionBuild, reproducedProduction);
  // fault 装配是独立的调试构建：写入 dist-mock，且不得改动生产 dist。
  run('pnpm', ['build:fault'], buildSource);
  await assertSameBuild(productionBuild, reproducedProduction);
  const faultEntry = await readFile(join(buildSource, 'dist-mock', 'index.html'), 'utf8');
  assert.notEqual(faultEntry, await readFile(join(productionBuild, 'index.html'), 'utf8'),
    'fault 构建与生产构建的入口应不同');
  run('pnpm', ['build:mock'], buildSource);
  await assertSameBuild(releaseA, join(buildSource, 'dist-mock'));
  console.log('PASS: 生产与显式 mock bundle 构建可复现；fault 构建单独输出且不改动生产产物');

  // 仅修改临时副本，再真实构建 B：不是手改 dist 或伪造新资源名。
  const mainPath = join(buildSource, 'src/main.ts');
  await writeFile(mainPath, `${await readFile(mainPath, 'utf8')}\ndocument.documentElement.dataset.deliveryRevision = 'release-b';\n`);
  const entryPath = join(buildSource, 'index.html');
  await writeFile(entryPath, (await readFile(entryPath, 'utf8')).replace('</title>', ' — delivery update</title>'));
  run('pnpm', ['build:mock'], buildSource);
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${baseURL}/dynamics/90071992547409934`);
  await page.locator('#preview-trigger-dynamic-90071992547409934-0').waitFor();
  await publishAndVerifyEntryUpdate({
    baseURL, workspace, current, previousBuild: releaseA, nextBuild: releaseB, page,
  });
  await page.locator('#preview-trigger-dynamic-90071992547409934-0').click();
  await page.locator('.preview-counter').waitFor();
  console.log('=== 阶段 2/3：mock 产物回退到上一版，旧/新哈希资源仍可达 ===');
  await rollbackAndVerify({
    baseURL, workspace, current, previousBuild: releaseA, nextBuild: releaseB, page,
    navigate: async target => {
      const routes = [
        ['/', target.getByRole('heading', { name: '全部动态' })],
        ['/ups/123', target.getByRole('heading', { name: 'UP 123 归档' })],
        ['/dynamics/90071992547409934', target.locator('#preview-trigger-dynamic-90071992547409934-0')],
        ['/dynamics/90071992547409934/comments/root-1', target.getByRole('button', { name: '返回评论' })],
        // 会话页：动态 + 根评论 + 入口回复都在地址里，直达/刷新同样只靠 SPA 回退与只读接口。
        ['/dynamics/90071992547409931/comments/90071992547401001/replies/90071992547401103/conversation',
          target.getByText('‹ 会话列表')],
        // mock 构建不启动真实 API，两条管理路由只到页头与读取错误，不假设有数据。
        ['/manage', target.getByRole('heading', { name: 'UP 监控管理' })],
        ['/manage/ups/202', target.getByRole('heading', { name: 'UP 监控管理' })],
      ];
      for (const [path, anchor] of routes) {
        const response = await target.goto(`${baseURL}${path}`);
        assert.equal(response.status(), 200, `${path} after rollback`);
        await anchor.waitFor();
      }
    },
  });
  await browser.close();
  browser = undefined;
  console.log('=== 阶段 3/3：生产构建 + 实际 API/collector（六路由、401、更新与回退） ===');
  await verifyProductionDeployment({
    repo, workspace, current, productionBuild, buildSource, apiPort, baseURL, authBaseURL,
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
  // 收尾仍以生产构建为准（mock/fault 只写 dist-mock，本不污染 dist）。
  run('pnpm', ['build']);
}
