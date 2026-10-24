// e2e 项目覆盖守卫：让"某个 spec 被不该跑的项目匹配"变成确定性断言。
// 每个 tests/e2e/*.spec.ts 必须在首部声明 `// @projects <逗号分隔的 project 名>`，
// 实测匹配集合（来自 Playwright 自己的 --list 结果）必须与声明完全一致。
// 使用方式：pnpm check:e2e-projects（已包含在 pnpm check 中）
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const specDir = join(process.cwd(), 'tests', 'e2e');
const declaration = /^\/\/\s*@projects\s+(.+)$/m;
const failures = [];

function actualProjects() {
  const binary = join(process.cwd(), 'node_modules', '.bin',
    process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
  const stdout = execFileSync(binary, ['test', '--list', '--reporter=json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
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

const actual = actualProjects();
const files = readdirSync(specDir).filter(name => name.endsWith('.spec.ts')).sort();
const rows = [];

for (const file of files) {
  const source = readFileSync(join(specDir, file), 'utf8');
  const declared = declaration.exec(source)?.[1]
    ?.split(',').map(name => name.trim()).filter(Boolean).sort();
  const matched = [...(actual.get(file) ?? [])].sort();
  rows.push(`${file.padEnd(28)} ${matched.join(', ') || '(无)'}`);

  if (!declared) {
    failures.push(`${file} 缺少首部声明：// @projects ${matched.join(', ') || '<project 名>'}`);
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
