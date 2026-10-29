// 票据 14 的视觉回归基准：把用户签收过的截图作为黄金图，与新一轮受控截图逐张比较。
// 日常比较：pnpm visual:compare
// 有意更新：pnpm visual:golden -- --reason "说明为什么视觉变化是预期的"
// 黄金图只允许在说明原因后更新；不能仅重跑基线掩盖意外变化。
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import {
  arg, conditionKeys, diffPixels, fuzz, goldenDir, hasFlag, imageSize, maxDiffRatio, sha256File,
  writeDiffImage,
} from './lib/visual-baseline.mjs';

const defaultCurrent = join(
  process.cwd(), '..', '.scratch', 'frontend-vue-migration', 'evidence', 'visual-14',
);
const manifestPath = join(goldenDir, 'manifest.json');
const diffDir = join(process.cwd(), 'test-results', 'visual-diff');

const currentDir = arg('--current') ?? defaultCurrent;
const update = hasFlag('--update');
const reason = arg('--reason');



const hash = sha256File;

async function writeManifest(files, conditions) {
  let previous = {};
  try {
    previous = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    previous = {};
  }
  const list = [];
  for (const name of files) {
    const path = join(goldenDir, name);
    list.push({ name, bytes: (await readFile(path)).byteLength, sha256: await hash(path) });
  }
  const manifest = {
    ticket: '14',
    baselineVersion: (previous.baselineVersion ?? 0) + 1,
    signedOff: previous.signedOff ?? {
      date: '2026-10-25',
      by: '用户（对话确认“这下可以了”）',
      candidateCommit: '89d0b49e213861badcecfe667de4f9330f134d22',
      scope: '全部 63 张受控截图（360/390/768/1280，含空态与错误态）',
      evidence: '.scratch/frontend-vue-migration/evidence/14-visual-baseline-preparation.md',
    },
    // 只保留比较所需的条件，避免把 63 张截图哈希在清单里重复一遍。
    conditions: conditions ? {
      sourceCommit: conditions.artifacts?.sourceCommit ?? null,
      environment: conditions.environment ?? {},
      build: conditions.artifacts?.build ?? [],
    } : previous.conditions ?? {},
    comparison: { metric: 'AE', fuzz, maxDiffRatio },
    updates: [
      ...(previous.updates ?? []),
      {
        date: new Date().toISOString().slice(0, 10),
        candidateCommit: conditions?.sourceCommit ?? conditions?.artifacts?.sourceCommit ?? null,
        reason: reason ?? '未填写',
      },
    ],
    files: list,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function updateGolden() {
  if (!reason) {
    console.error('更新黄金图必须说明原因：pnpm visual:golden -- --reason "为什么这是预期变化"');
    process.exit(2);
  }
  const current = (await readdir(currentDir)).filter(name => name.endsWith('.png')).sort();
  if (current.length === 0) {
    console.error(`当前截图目录为空：${currentDir}；先运行 pnpm visual:baseline`);
    process.exit(2);
  }
  await mkdir(goldenDir, { recursive: true });
  for (const name of (await readdir(goldenDir)).filter(name => name.endsWith('.png'))) {
    if (!current.includes(name)) await rm(join(goldenDir, name));
  }
  for (const name of current) await copyFile(join(currentDir, name), join(goldenDir, name));
  let conditions = null;
  try {
    conditions = JSON.parse(await readFile(join(currentDir, 'conditions.json'), 'utf8'));
  } catch {
    conditions = null;
  }
  const manifest = await writeManifest(current, conditions);
  console.log(`黄金图已更新：${current.length} 张 → ${goldenDir}（版本 ${manifest.baselineVersion}）`);
  console.log(`原因：${reason}`);
}

async function compare() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    console.error(`缺少黄金图清单：${manifestPath}；先由用户签收后运行 pnpm visual:golden`);
    process.exit(2);
  }

  const currentNames = (await readdir(currentDir)).filter(name => name.endsWith('.png')).sort();
  if (currentNames.length === 0) {
    console.error(`当前截图目录为空：${currentDir}；先运行 pnpm visual:baseline`);
    process.exit(2);
  }

  const expected = manifest.files.map(file => file.name).sort();
  const missing = expected.filter(name => !currentNames.includes(name));
  const extra = currentNames.filter(name => !expected.includes(name));
  if (missing.length || extra.length) {
    console.error('截图集合与黄金图不一致：');
    if (missing.length) console.error(`- 缺少：${missing.join(', ')}`);
    if (extra.length) console.error(`- 新增：${extra.join(', ')}`);
    process.exit(1);
  }

  try {
    const conditions = JSON.parse(await readFile(join(currentDir, 'conditions.json'), 'utf8'));
    const recorded = manifest.conditions?.environment ?? {};
    const actual = conditions.environment ?? {};
    const keys = conditionKeys;
    const changed = keys.filter(key => JSON.stringify(recorded[key]) !== JSON.stringify(actual[key]));
    if (changed.length) {
      console.error(`截图条件与黄金图不一致，比较不可信：${changed.join(', ')}`);
      console.error('如确需更换环境基准，请说明原因后更新黄金图。');
      process.exit(1);
    }
  } catch {
    console.error('缺少或无法读取当前 conditions.json；先运行 pnpm visual:baseline');
    process.exit(2);
  }

  await rm(diffDir, { recursive: true, force: true });
  const failures = [];
  for (const file of manifest.files) {
    const golden = join(goldenDir, file.name);
    const current = join(currentDir, file.name);
    const a = imageSize(golden);
    const b = imageSize(current);
    if (a.width !== b.width || a.height !== b.height) {
      failures.push({ name: file.name, detail: `尺寸 ${a.width}x${a.height} → ${b.width}x${b.height}` });
      continue;
    }
    const pixels = diffPixels(golden, current);
    const ratio = pixels / (a.width * a.height);
    if (ratio > maxDiffRatio) {
      await mkdir(diffDir, { recursive: true });
      const diffPath = join(diffDir, basename(file.name));
      writeDiffImage(golden, current, diffPath);
      failures.push({ name: file.name, detail: `差异 ${Math.round(pixels)} px（${(ratio * 100).toFixed(3)}%）` });
    }
  }

  if (failures.length > 0) {
    console.error(`视觉回归失败：${failures.length}/${manifest.files.length} 张与黄金图不一致`);
    for (const failure of failures) console.error(`- ${failure.name}：${failure.detail}`);
    console.error(`差异图：${diffDir}`);
    console.error('确认变化是预期的，才用 --reason 更新黄金图；否则修复实现。');
    process.exit(1);
  }
  console.log(`视觉回归通过：${manifest.files.length} 张与黄金图一致（AE，fuzz ${fuzz}，阈值 ${maxDiffRatio * 100}%）`);
  console.log(`基准版本 ${manifest.baselineVersion}，签收候选 ${manifest.signedOff.candidateCommit}`);
}

if (update) await updateGolden();
else await compare();
