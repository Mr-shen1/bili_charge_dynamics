import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 目标设备含 iOS 16.4（票据 01 与 15 的真机基线）。Vite 只转译语法、不 polyfill Web API，
// 因此「语法能过、运行时不存在的接口」必须在源码里挡住：真机上它会同步抛错，
// 而管理写入这类路径一旦同步抛错就会卡住界面（票据 15 的 F-15-01 就是这样暴露的）。
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

const missingOnTarget = [
  { api: 'AbortSignal.any', pattern: /AbortSignal\.any\s*\(/, available: 'Safari 17.4' },
  { api: 'Promise.withResolvers', pattern: /Promise\.withResolvers\s*\(/, available: 'Safari 17.4' },
  { api: 'Object.groupBy', pattern: /Object\.groupBy\s*\(/, available: 'Safari 17.4' },
  { api: 'Map.groupBy', pattern: /Map\.groupBy\s*\(/, available: 'Safari 17.4' },
];

/** 只看真正会被执行的代码：注释里写出的 API 名（含说明为何不能用它）不算依赖。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|vue)$/.test(entry.name) && statSync(full).isFile() ? [full] : [];
  });
}

describe('目标浏览器基线（iOS 16.4）', () => {
  for (const { api, pattern, available } of missingOnTarget) {
    it(`不依赖 ${api}（${available} 才有）`, () => {
      const offenders = sourceFiles(sourceRoot)
        .filter(file => pattern.test(stripComments(readFileSync(file, 'utf8'))))
        .map(file => relative(sourceRoot, file));
      expect(offenders, `${api} 需要 ${available}，低于该版本会同步抛错；请改用自实现的降级路径`)
        .toEqual([]);
    });
  }
});
