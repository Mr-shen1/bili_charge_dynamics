// 票据 15：登记设备验收候选（源码提交 + 构建产物指纹），并校验设备实测产物是否仍属同一候选。
//
// 用法（在仓库任意目录执行均可）：
//   node .scratch/frontend-vue-migration/evidence/device-15/capture-candidate.mjs
//     重新生成同目录的 candidate.json；候选变化（产品代码、依赖、构建配置）后必须重跑。
//   node .../capture-candidate.mjs --verify
//     校验 frontend/dist 与 frontend/dist-mock 与 candidate.json 一致，不一致非零退出。
//
// 设备验收证据必须引用 candidate.json 里的 commit 与产物指纹：产物文件名带内容哈希，
// 所以换一次构建就会暴露“设备测的不是这份候选”。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const frontend = join(repoRoot, 'frontend');
const candidatePath = join(here, 'candidate.json');
const artifacts = ['dist', 'dist-mock'];
// 候选 = 能改变产物或被测环境的路径。只改文档、测试、证据或工具配置不换候选，
// 所以设备验收期间的证据提交不会让 --verify 失效。
const productPaths = [
  'frontend/src',
  'frontend/public',
  'frontend/server',
  'frontend/index.html',
  'frontend/vite.config.ts',
  'frontend/package.json',
  'frontend/pnpm-lock.yaml',
];

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const full = join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    })
    .sort();
}

function fingerprint(directory) {
  const files = walk(join(frontend, directory)).map(full => {
    const bytes = readFileSync(full);
    return {
      path: relative(join(frontend, directory), full),
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const index = files.find(file => file.path === 'index.html');
  const html = index ? readFileSync(join(frontend, directory, 'index.html'), 'utf8') : '';
  return {
    files: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    indexSha256: index?.sha256 ?? null,
    entryScript: html.match(/src="([^"]+\.js)"/)?.[1] ?? null,
    entryStyle: html.match(/href="([^"]+\.css)"/)?.[1] ?? null,
    hashes: files,
  };
}

function packageVersions() {
  const pkg = JSON.parse(readFileSync(join(frontend, 'package.json'), 'utf8'));
  const pick = names => Object.fromEntries(names.map(name => [name, pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null]));
  return pick(['vue', 'vue-router', 'element-plus', 'vite', 'typescript', 'vue-tsc', 'vitest', '@playwright/test']);
}

function readCandidate() {
  const status = git(['status', '--porcelain', '--', ...productPaths]);
  const productDirty = status === '' ? [] : status.split('\n');
  return {
    recordedAt: new Date().toISOString(),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: git(['rev-parse', 'HEAD']),
    commitShort: git(['rev-parse', '--short', 'HEAD']),
    commitSubject: git(['log', '-1', '--pretty=%s']),
    productDirty,
    lockfileSha256: createHash('sha256').update(readFileSync(join(frontend, 'pnpm-lock.yaml'))).digest('hex'),
    node: process.version,
    versions: packageVersions(),
    artifacts: Object.fromEntries(artifacts.map(name => [name, fingerprint(name)])),
  };
}

function absentArtifacts() {
  return artifacts.filter(name => !existsSync(join(frontend, name, 'index.html')));
}

function refuseWhenArtifactsMissing() {
  const absent = absentArtifacts();
  if (absent.length === 0) return;
  console.error(`缺少构建产物：${absent.join('、')}（先跑 pnpm check:dist 或 build + build:mock）。`);
  process.exit(1);
}

if (process.argv.includes('--verify')) {
  if (!existsSync(candidatePath)) {
    console.error('缺少 candidate.json：先运行 node capture-candidate.mjs 登记候选。');
    process.exit(1);
  }
  refuseWhenArtifactsMissing();
  const recorded = JSON.parse(readFileSync(candidatePath, 'utf8'));
  const live = readCandidate();
  const problems = [];
  for (const name of artifacts) {
    const want = recorded.artifacts?.[name];
    const got = live.artifacts[name];
    if (!want) {
      problems.push(`${name}：candidate.json 未登记该产物`);
      continue;
    }
    if (want.indexSha256 !== got.indexSha256 || want.entryScript !== got.entryScript || want.entryStyle !== got.entryStyle) {
      problems.push(`${name}：入口与登记不一致（登记 ${want.entryScript}，当前 ${got.entryScript}）`);
      continue;
    }
    // 逐文件双向比对：只比「当前已存在的文件」会漏掉被删除的按需 chunk。
    const changed = got.hashes.filter(file => want.hashes.find(other => other.path === file.path)?.sha256 !== file.sha256);
    const removed = want.hashes.filter(file => !got.hashes.some(other => other.path === file.path));
    if (changed.length > 0) problems.push(`${name}：${changed.length} 个文件与登记不一致（首个 ${changed[0].path}）`);
    if (removed.length > 0) problems.push(`${name}：登记里有 ${removed.length} 个文件已不存在（首个 ${removed[0].path}）`);
    if (want.totalBytes !== got.totalBytes) problems.push(`${name}：总字节 ${got.totalBytes} 与登记 ${want.totalBytes} 不符`);
  }
  if (live.commit !== recorded.commit) {
    // 只提交文档/证据也会移动 HEAD；真正要保证的是产品树与登记时的候选一致。
    const drift = git(['diff', '--name-only', recorded.commit, 'HEAD', '--', ...productPaths]);
    if (drift !== '') {
      problems.push(`登记 ${recorded.commitShort} 与本 HEAD ${live.commitShort} 之间的产品文件有改动：${drift.split('\n').slice(0, 3).join('、')}`);
    }
  }
  if (live.productDirty.length > 0) problems.push(`产品文件有未提交改动：${live.productDirty.slice(0, 3).join('、')}`);
  if (problems.length > 0) {
    console.error('产物不属于已登记的验收候选，不能作为该候选的设备证据：');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(`产物与已登记候选一致：${recorded.commitShort} ${recorded.artifacts.dist.entryScript} / ${recorded.artifacts['dist-mock'].entryScript}`);
  if (live.commit !== recorded.commit) console.log(`（当前 HEAD ${live.commitShort} 只多了不改变产品树的提交）`);
  process.exit(0);
}

refuseWhenArtifactsMissing();
writeFileSync(candidatePath, `${JSON.stringify(readCandidate(), null, 2)}\n`);
const recorded = JSON.parse(readFileSync(candidatePath, 'utf8'));
console.log(`已登记候选 ${recorded.commitShort}（${recorded.branch}）`);
for (const name of artifacts) {
  const artifact = recorded.artifacts[name];
  console.log(`  ${name}: ${artifact.files} 个文件 / ${artifact.totalBytes} 字节，入口 ${artifact.entryScript}，index.html ${artifact.indexSha256.slice(0, 12)}`);
}
if (recorded.productDirty.length > 0) {
  console.log(`注意：产品相关文件有未提交改动，共 ${recorded.productDirty.length} 项——设备证据只能代表这份脏工作区。`);
}
