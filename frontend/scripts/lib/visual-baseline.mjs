// 票据 14/17 视觉复核共用的基础件：黄金图位置、比较口径、ImageMagick 调用与命令行参数。
// 由 `compare-visual-baseline.mjs`（判定）与 `visual-diff-report.mjs`（逐张数值报告）共用，
// 避免两处各写一套路径、容差与解析逻辑。
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 用户签收的黄金图目录与清单。 */
export const goldenDir = join(process.cwd(), 'tests', 'visual-baseline');
export const goldenManifestPath = join(goldenDir, 'manifest.json');

/** 比较口径：抗锯齿差异由 1% fuzz 吸收；阈值换算见 manifest 的 `comparison`。 */
export const fuzz = '1%';
export const maxDiffRatio = 0.0002;

/** 与 `compare-visual-baseline.mjs` 相同的条件键：环境不一致时比较不可信。 */
export const conditionKeys = ['browser', 'deviceScaleFactor', 'widths', 'timezoneId', 'locale', 'fontFamily', 'resolvedFont'];

/** `--name value` 形式的参数。 */
export function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

/** `--flag` 形式的存在性判断。 */
export function hasFlag(name) {
  return process.argv.includes(name);
}

function run(args, { allowFailure = false } = {}) {
  const result = spawnSync('magick', args, { encoding: 'utf8' });
  if (result.error) throw new Error(`需要 ImageMagick（magick）：${result.error.message}`);
  // `compare` 发现差异时退出码为 1，度量值仍写在 stderr。
  if (!allowFailure && result.status !== 0) {
    throw new Error(`magick ${args.join(' ')} 失败：${(result.stderr ?? '').trim()}`);
  }
  return `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
}

/** 图片尺寸，用于把像素差换算成比例。 */
export function imageSize(path) {
  const [width, height] = run(['identify', '-format', '%w %h', path]).split(' ').map(Number);
  return { width, height };
}

/**
 * AE 差异度量。
 * - 传 fuzz（默认与判定口径一致）时，返回「超出容差的像素数」，用来判定通过/失败；
 * - 传 `null` 表示不加容差，返回权重和：HDRI 构建下可能是小数，`0.14` 表示差异远小于一个像素。
 */
export function diffPixels(golden, current, fuzzValue = fuzz) {
  const args = ['compare', '-metric', 'AE'];
  if (fuzzValue) args.push('-fuzz', fuzzValue);
  args.push(golden, current, 'null:');
  const value = Number.parseFloat(run(args, { allowFailure: true }));
  return Number.isFinite(value) ? value : 0;
}

/**
 * 写出与黄金图的差异图（红＝超出容差的像素）：失败报告需要它来解释“差在哪”，
 * 因此预期差异时必须真的产出文件，而不是在报告路径上抛错。
 * `compare` 发现差异时退出码为 1，但输出文件已经写好，所以这里允许非零退出；
 * 工具本身不可用仍然报错（不把环境问题伪装成无差异）。
 */
export function writeDiffImage(golden, current, output) {
  run(['compare', '-highlight-color', 'red', '-lowlight-color', 'white', golden, current, output],
    { allowFailure: true });
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function readGoldenManifest() {
  try {
    return JSON.parse(await readFile(goldenManifestPath, 'utf8'));
  } catch {
    throw new Error(`缺少黄金图清单：${goldenManifestPath}；先由用户签收后运行 pnpm visual:golden`);
  }
}
