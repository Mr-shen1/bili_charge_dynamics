// 构建产物隔离检查：让“生产不含 mock/fault 入口与夹具”成为可执行的确定性断言，
// 而不是人工 grep。使用方式：
//   pnpm build && pnpm build:mock && pnpm check:isolation
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HASHED_ASSET, MIN_ROUTE_CHUNKS, routeChunkNames } from './lib/build-assets.mjs';

const root = process.cwd();
const productionDir = join(root, 'dist');
const mockDir = join(root, 'dist-mock');
const failures = [];

// 夹具独有的标记：mock 构建必须命中，生产构建必须为 0。
// 占位图是生产页面自有的异常图片资源，不再属于夹具独有标记；夹具缩略/预览/异常地址仍必须缺席。
const fixtureMarkers = ['/images/full/', '/images/thumb/', '/images/broken/', '/images/invalid/', '/images/flaky/'];
const mockArchiveMarkers = ['mock-archive:'];
const mockChunkPattern = /Preview(Fixtures|Other)Page/;

function collectFiles(dir) {
  const files = [];
  const walk = current => {
    for (const entry of readdirSync(current)) {
      const absolute = join(current, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else files.push(absolute);
    }
  };
  walk(dir);
  return files;
}

function checkAssets(dir, label) {
  const entry = join(dir, 'index.html');
  if (!existsSync(entry)) {
    failures.push(`${label} 缺少 index.html 入口`);
    return;
  }
  // 入口引用的资源必须真实存在；不再用“任意 index-*.js”这种过宽的名字猜测证明产物完整。
  const html = readFileSync(entry, 'utf8');
  const refs = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]))];
  if (!refs.some(path => path.endsWith('.js'))) failures.push(`${label} 入口未引用哈希脚本`);
  if (!refs.some(path => path.endsWith('.css'))) failures.push(`${label} 入口未引用哈希样式`);
  for (const ref of refs) {
    if (!existsSync(join(dir, ref.slice(1)))) failures.push(`${label} 入口引用的 ${ref} 不存在`);
  }
  const assetsDir = join(dir, 'assets');
  if (!existsSync(assetsDir)) {
    failures.push(`${label} 缺少 assets 目录`);
    return;
  }
  const assets = readdirSync(assetsDir);
  const unhashed = assets.filter(name => !HASHED_ASSET.test(name));
  if (unhashed.length > 0) failures.push(`${label} /assets/ 含未内容哈希文件：${unhashed.join(', ')}`);
  // 路由级 chunk 是入口之外的拆包资源，只查入口脚本会漏掉它们。
  const routeChunks = routeChunkNames(assets);
  if (routeChunks.length < MIN_ROUTE_CHUNKS) {
    failures.push(`${label} 路由级 chunk 少于六条路由（${routeChunks.length}）`);
  }
}

function check(dir, expectation) {
  const label = relative(root, dir) || dir;
  if (!existsSync(dir)) {
    failures.push(`${label} 不存在：先运行 ${expectation === 'production' ? 'pnpm build' : 'pnpm build:mock'}`);
    return;
  }
  const files = collectFiles(dir);
  const mockChunks = files.map(file => relative(dir, file)).filter(file => mockChunkPattern.test(file));
  const hitMarkers = new Set();
  const hitArchiveMarkers = new Set();
  for (const file of files) {
    if (!/\.(js|css|html)$/.test(file)) continue;
    const content = readFileSync(file, 'utf8');
    for (const marker of fixtureMarkers) if (content.includes(marker)) hitMarkers.add(marker);
    for (const marker of mockArchiveMarkers) if (content.includes(marker)) hitArchiveMarkers.add(marker);
  }

  if (expectation === 'production') {
    if (mockChunks.length > 0) failures.push(`${label} 含 mock 页面 chunk：${mockChunks.join(', ')}`);
    if (hitMarkers.size > 0) failures.push(`${label} 含夹具地址标记：${[...hitMarkers].join(', ')}`);
    if (hitArchiveMarkers.size > 0) failures.push(`${label} 含 mock 归档读取数据：${[...hitArchiveMarkers].join(', ')}`);
    // 生产页面展示 pending/failed 时依赖应用自有占位图；缺失会让真实异常图片变成坏链。
    if (!existsSync(join(dir, 'images', 'unavailable', 'placeholder.svg'))) {
      failures.push(`${label} 缺少应用自有图片占位资源`);
    }
  } else {
    if (mockChunks.length === 0) failures.push(`${label} 缺少 mock 自检页面 chunk，mock 装配可能未生效`);
    if (hitMarkers.size === 0) failures.push(`${label} 未包含夹具地址标记，自检数据可能未打进产物`);
    if (hitArchiveMarkers.size === 0) failures.push(`${label} 未包含 mock 归档读取数据，mock 装配可能未生效`);
  }
  checkAssets(dir, label);
}

check(productionDir, 'production');
check(mockDir, 'mock');

if (failures.length > 0) {
  console.error('构建产物隔离检查未通过：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('构建产物隔离检查通过：dist 无 mock 入口/夹具/归档数据，dist-mock 含自检页面与夹具。');
