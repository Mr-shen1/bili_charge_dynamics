// 视觉复核报告：把「候选截图目录」与用户签收的黄金图逐张比较，写出可复核的 JSON。
//
// 与 `compare-visual-baseline.mjs` 的分工：那个脚本只做通过/失败判定（与 `visual:compare` 同口径），
// 本脚本额外记录每张图的三个数值——sha256 是否完全相同、AE@判定 fuzz（与判定口径一致）、
// 不含容差的 AE 权重和（区分「抗锯齿级差异」与「视觉变化」），供证据文档引用。
//
// 用法：pnpm visual:diff-report --current ../.scratch/frontend-vue-migration/evidence/visual-17
//      可选 --out <文件>，默认写到截图目录下的 diff-report.json
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  arg, conditionKeys, diffPixels, fuzz, goldenDir, imageSize, readGoldenManifest, sha256File,
} from './lib/visual-baseline.mjs';

const currentDir = arg('--current');
if (!currentDir) {
  console.error('需要 --current <截图目录>：先 `VISUAL_OUT_DIR=<该目录> pnpm visual:baseline`');
  process.exit(2);
}

/** 截图条件必须与基准一致，否则「零差异」不可信（与 visual:compare 同一条要求）。 */
async function assertSameConditions(manifest) {
  let conditions;
  try {
    conditions = JSON.parse(await readFile(join(currentDir, 'conditions.json'), 'utf8'));
  } catch {
    console.error(`缺少或无法读取 ${join(currentDir, 'conditions.json')}；先运行 pnpm visual:baseline`);
    process.exit(2);
  }
  const recorded = manifest.conditions?.environment ?? {};
  const actual = conditions.environment ?? {};
  const changed = conditionKeys.filter(key => JSON.stringify(recorded[key]) !== JSON.stringify(actual[key]));
  if (changed.length > 0) {
    console.error(`截图条件与黄金图不一致，比较不可信：${changed.join(', ')}`);
    process.exit(2);
  }
  return conditions;
}

const manifest = await readGoldenManifest().catch(error => {
  console.error(error.message);
  process.exit(2);
});
const conditions = await assertSameConditions(manifest);

const images = [];
for (const file of manifest.files) {
  const golden = join(goldenDir, file.name);
  const current = join(currentDir, file.name);
  let size;
  try {
    size = imageSize(golden);
  } catch (error) {
    console.error(`无法读取黄金图 ${golden}：${error.message}`);
    process.exit(2);
  }
  const [goldenSha, currentSha] = await Promise.all([sha256File(golden), sha256File(current)]).catch(() => {
    console.error(`缺少候选截图 ${current}；先运行 pnpm visual:baseline 生成全部 ${manifest.files.length} 张`);
    process.exit(2);
  });
  images.push({
    name: file.name,
    width: size.width,
    height: size.height,
    identicalBytes: goldenSha === currentSha,
    diffPixelsFuzz: diffPixels(golden, current),
    // HDRI 构建下 AE 权重和可为小数：0.14 表示差异远小于一个像素。
    diffWeightNoFuzz: diffPixels(golden, current, null),
    ratioNoFuzz: Number((diffPixels(golden, current, null) / (size.width * size.height)).toFixed(8)),
  });
}

const report = {
  baselineVersion: manifest.baselineVersion,
  signedOffCandidate: manifest.signedOff?.candidateCommit ?? null,
  metric: { ...(manifest.comparison ?? {}), fuzz },
  candidate: {
    sourceCommit: conditions.artifacts?.sourceCommit ?? null,
    sourceStatus: conditions.artifacts?.sourceStatus ?? null,
  },
  imagesTotal: images.length,
  identicalBytes: images.filter(image => image.identicalBytes).length,
  imagesWithDiffPixels: images.filter(image => image.diffWeightNoFuzz > 0).length,
  maxRatioNoFuzz: Math.max(...images.map(image => image.ratioNoFuzz)),
  images,
};

const outPath = arg('--out') ?? join(currentDir, 'diff-report.json');
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `视觉差异报告：${report.imagesTotal} 张，字节完全相同 ${report.identicalBytes} 张，`
  + `仍有像素权重差 ${report.imagesWithDiffPixels} 张，最大差异比例 ${(report.maxRatioNoFuzz * 100).toFixed(6)}%`,
);
console.log(`已写入 ${outPath}`);
