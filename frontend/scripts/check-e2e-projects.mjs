// e2e 项目覆盖守卫：让"某个 spec 被不该跑的项目匹配"变成确定性断言。
// 每个 tests/e2e/*.spec.ts 必须在首部声明 `// @projects <逗号分隔的 project 名>`，
// 实测匹配集合（来自 Playwright 自己的 --list 结果）必须与声明完全一致。
// 只在静态交付环境跑的 spec 用 `// @projects nginx: <project 名>`：该矩阵由
// E2E_TARGET=nginx 的 --list 结果核对，normal 环境不匹配它也不报错。
// 使用方式：pnpm check:e2e-projects（已包含在 pnpm check 中）
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const specDir = join(process.cwd(), 'tests', 'e2e');
const declaration = /^\/\/\s*@projects\s+(.+)$/m;
const failures = [];

function actualProjects(target) {
  const binary = join(process.cwd(), 'node_modules', '.bin',
    process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  // normal 矩阵必须与调用者的 E2E_TARGET 无关，否则在 nginx 环境下会把普通 spec 误报成“(无)”。
  const env = { ...process.env };
  delete env.E2E_TARGET;
  if (target) env.E2E_TARGET = target;
  const stdout = execFileSync(binary, ['test', '--list', '--reporter=json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, env,
  });
  const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
  const matrix = new Map();
  const walk = (suites, file) => {
    for (const suite of suites) {
      const current = suite.file ?? file;
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          if (!current || !test.projectName) continue;
          const names = matrix.get(current) ?? new Set();
          names.add(test.projectName);
          matrix.set(current, names);
        }
      }
      walk(suite.suites ?? [], current);
    }
  };
  walk(report.suites ?? [], null);
  return matrix;
}

const matrices = new Map();
function matrixFor(target) {
  if (!matrices.has(target)) matrices.set(target, actualProjects(target));
  return matrices.get(target);
}
const normalMatrix = matrixFor(undefined);

const files = readdirSync(specDir).filter(name => name.endsWith('.spec.ts')).sort();
const rows = [];

for (const file of files) {
  const source = readFileSync(join(specDir, file), 'utf8');
  const declarationText = declaration.exec(source)?.[1];
  const nginxOnly = declarationText?.startsWith('nginx:') ?? false;
  const declared = declarationText
    ?.replace(/^nginx:\s*/, '')
    .split(',').map(name => name.trim()).filter(Boolean).sort();
  const matched = [...matrixFor(nginxOnly ? 'nginx' : undefined).get(file) ?? []].sort();
  // nginx 专用 spec 必须同时满足：普通矩阵不匹配它（否则普通 e2e 会去连不存在的 Nginx）。
  const normalMatch = [...(normalMatrix.get(file) ?? [])].sort();
  rows.push(`${file.padEnd(28)} ${matched.join(', ') || '(无)'}${nginxOnly ? '  [E2E_TARGET=nginx]' : ''}`);

  if (!declared) {
    failures.push(`${file} 缺少首部声明：// @projects ${matched.join(', ') || '<project 名>'}`);
    continue;
  }
  if (nginxOnly && normalMatch.length > 0) {
    failures.push(`${file} 声明为 nginx 专用，却被普通项目匹配到：${normalMatch.join(', ')}（检查 testIgnore）`);
    continue;
  }
  if (matched.length === 0) {
    failures.push(`${file} 没有被任何 project 匹配（声明 ${declared.join(', ')}），检查 testMatch/testIgnore`);
    continue;
  }
  const missing = declared.filter(name => !matched.includes(name));
  const extra = matched.filter(name => !declared.includes(name));
  if (missing.length > 0) failures.push(`${file} 声明的 project 未匹配到：${missing.join(', ')}`);
  if (extra.length > 0) failures.push(`${file} 被声明外的 project 匹配到：${extra.join(', ')}`);
}

if (failures.length > 0) {
  console.error('e2e 项目覆盖检查未通过：');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('\n实测矩阵：\n' + rows.map(row => `  ${row}`).join('\n'));
  process.exit(1);
}
console.log('e2e 项目覆盖与各 spec 的 @projects 声明一致：');
for (const row of rows) console.log(`  ${row}`);
