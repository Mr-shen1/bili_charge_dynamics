// 迁移期守卫：frontend/src/data 是根 src/data 的临时副本，必须保持逐字节一致。
// 票据 12/17 删除 React 栈时，root 副本与本源文件一起移除，本脚本随之删除。
//   pnpm check:data-parity
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const names = ['contracts.ts', 'identifiers.ts', 'guards.ts', 'timestamp.ts', 'checkStatus.ts', 'commentProgress.ts',
  'commentSyncErrors.ts', 'archiveReader.ts'];
const root = process.cwd();
const copies = names.map(name => ({
  name,
  react: join(root, '..', 'src', 'data', name),
  vue: join(root, 'src', 'data', name),
}));

const failures = [];
for (const { name, react, vue } of copies) {
  if (!existsSync(react) || !existsSync(vue)) {
    failures.push(`${name} 缺失（React: ${existsSync(react)}，Vue: ${existsSync(vue)}）`);
    continue;
  }
  if (readFileSync(react, 'utf8') !== readFileSync(vue, 'utf8')) failures.push(`${name} 与根 src/data 版本不一致`);
}

if (failures.length > 0) {
  console.error('前端数据层副本检查未通过：');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('前端数据层副本与根 src/data 一致。');
