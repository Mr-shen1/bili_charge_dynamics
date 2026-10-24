// 构建产物隔离检查：让“生产不含 mock/fault 入口与夹具”成为可执行的确定性断言，
// 而不是人工 grep。使用方式：
//   pnpm build && pnpm build:mock && pnpm check:isolation
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const productionDir = join(root, 'dist');
const mockDir = join(root, 'dist-mock');
const failures = [];

// 夹具独有的标记：mock 构建必须命中，生产构建必须为 0。
const fixtureMarkers = ['/images/full/', '/images/unavailable/'];
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

function check(dir, expectation) {
  const label = relative(root, dir) || dir;
  if (!existsSync(dir)) {
    failures.push(`${label} 不存在：先运行 ${expectation === 'production' ? 'pnpm build' : 'pnpm build:mock'}`);
    return;
  }
  const files = collectFiles(dir);
  const mockChunks = files.map(file => relative(dir, file)).filter(file => mockChunkPattern.test(file));
  const hitMarkers = new Set();
  for (const file of files) {
    if (!/\.(js|css|html)$/.test(file)) continue;
    const content = readFileSync(file, 'utf8');
    for (const marker of fixtureMarkers) if (content.includes(marker)) hitMarkers.add(marker);
  }

  if (expectation === 'production') {
    if (mockChunks.length > 0) failures.push(`${label} 含 mock 页面 chunk：${mockChunks.join(', ')}`);
    if (hitMarkers.size > 0) failures.push(`${label} 含夹具地址标记：${[...hitMarkers].join(', ')}`);
    if (!files.some(file => /index-.*\.js$/.test(relative(dir, file)))) failures.push(`${label} 缺少入口 chunk，产物可能不完整`);
  } else {
    if (mockChunks.length === 0) failures.push(`${label} 缺少 mock 自检页面 chunk，mock 装配可能未生效`);
    if (hitMarkers.size === 0) failures.push(`${label} 未包含夹具地址标记，自检数据可能未打进产物`);
  }
}

check(productionDir, 'production');
check(mockDir, 'mock');

if (failures.length > 0) {
  console.error('构建产物隔离检查未通过：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('构建产物隔离检查通过：dist 无 mock 入口与夹具，dist-mock 含自检页面与夹具。');
