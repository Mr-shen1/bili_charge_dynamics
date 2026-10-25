// 票据 15：环境 A 清单自检——把 `15-real-device-acceptance.md` 第 5 节写明的入口与预期
// 在自动化 Chromium 上跑一遍，确认清单本身与候选代码一致（标签对不上时先修清单，不留坑给人工）。
//
// 这**不是**设备证据：它跑的是自动化 Chromium + 手机模拟，只证明清单步骤可达、入口名称正确；
// 真机渲染、触摸手势、Safari 历史与滚动仍须人工实测。
// 用法：先启动 serve-env-a.sh，然后 node checklist-selftest.mjs [http://127.0.0.1:4318]
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本目录不在 frontend/ 的依赖树下，按 frontend/package.json 解析 @playwright/test。
// 放在证据目录、不进 frontend/scripts：它是票据 15 的一次性证据工具（故意不自触发），
// 真正的产品回归入口仍是 frontend 的 pnpm check / test:e2e。
const here = dirname(fileURLToPath(import.meta.url));
const frontend = resolve(here, '../../../..', 'frontend');
const { chromium } = createRequire(join(frontend, 'package.json'))('@playwright/test');

const base = process.argv[2] ?? 'http://127.0.0.1:4318';
const results = [];

async function check(row, description, run) {
  try {
    await run();
    results.push({ row, description, ok: true });
  } catch (error) {
    results.push({ row, description, ok: false, detail: String(error).split('\n')[0] });
  }
}

const viewer = page => page.locator('.el-image-viewer__wrapper');

const browser = await chromium.launch();

// 宽屏：列表、追加、评论排序与追加、宽屏内联回复、长图预览。
const wide = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

await check('A1', '「全部归档」首批 10 条，两次「加载更多」到 25 条后按钮消失', async () => {
  await wide.goto(`${base}/`);
  await wide.getByRole('link', { name: '全部归档' }).waitFor();
  await wide.getByRole('article').nth(9).waitFor();
  if (await wide.getByRole('article').count() !== 10) throw new Error('首批不是 10 条');
  await wide.getByRole('button', { name: '加载更多' }).click();
  await wide.getByRole('article').nth(19).waitFor();
  await wide.getByRole('button', { name: '加载更多' }).click();
  await wide.getByRole('article').nth(24).waitFor();
  if (await wide.getByRole('button', { name: '加载更多' }).count() !== 0) throw new Error('第 25 条后仍有加载更多');
});

await check('A2', '归档范围导航有「纸飞机」「另一位 UP」，切到「纸飞机」只剩该作者', async () => {
  await wide.getByRole('link', { name: '另一位 UP' }).waitFor();
  await wide.getByRole('link', { name: '纸飞机' }).click();
  await wide.waitForURL(/\/ups\/123$/, { timeout: 10_000 });
  await wide.getByRole('article').first().waitFor();
  const authors = await wide.getByRole('article').evaluateAll(nodes => nodes.map(node => node.textContent ?? ''));
  if (authors.some(text => text.includes('另一位 UP'))) throw new Error('单 UP 列表里混入另一位 UP 的动态');
});

await check('A3', '第 1 条动态的「来源评论 45」入口展开评论区与排序', async () => {
  await wide.goto(`${base}/`);
  await wide.getByRole('button', { name: '来源评论 45' }).click();
  const region = wide.getByRole('region', { name: '评论区' });
  await region.getByRole('radiogroup', { name: '评论排序' }).waitFor();
  await region.getByText('最热', { exact: true }).waitFor();
  await region.getByText('最新', { exact: true }).waitFor();
});

await check('A4', '一级评论两次「加载更多评论」后按钮消失（共 45 条）', async () => {
  const region = wide.getByRole('region', { name: '评论区' });
  await region.getByRole('button', { name: '加载更多评论' }).click();
  await region.getByRole('button', { name: '加载更多评论' }).click();
  await region.getByRole('button', { name: '加载更多评论' }).waitFor({ state: 'detached' });
  if (!(await region.innerText()).includes('45')) throw new Error('评论区没有显示 45 条');
});

await check('A5', '宽屏带回复的评论项点「展开回复」后有分页 1/2/3 与「收起」', async () => {
  const region = wide.getByRole('region', { name: '评论区' });
  const items = region.getByRole('listitem');
  // 「展开回复」是库外按钮、无 aria-label，只能按可见文字找；展开后该按钮变成分页，所以先取索引。
  const index = await items.evaluateAll(nodes => nodes.findIndex(node => [...node.querySelectorAll('button')].some(button => (button.innerText || '').trim() === '展开回复')));
  if (index < 0) throw new Error('评论区里找不到「展开回复」入口');
  await items.nth(index).getByRole('button', { name: '展开回复', exact: true }).click();
  const pager = region.getByRole('navigation', { name: '回复分页' });
  await pager.waitFor();
  await pager.getByText('共3页').waitFor();
  await pager.getByRole('button', { name: '收起', exact: true }).waitFor();
});

await check('A8', '第 6 条动态的长图能打开预览（1200×6000）', async () => {
  await wide.goto(`${base}/`);
  const card = wide.getByRole('article').nth(5);
  await card.getByRole('button', { name: '预览动态图片 1' }).click();
  await viewer(wide).waitFor();
  const height = await wide.locator('.el-image-viewer__canvas img').first().evaluate(node => node.naturalHeight);
  if (height < 3000) throw new Error(`预览里的图不是长图（naturalHeight=${height}）`);
  await wide.keyboard.press('Escape');
});

await check('A9', '十二图组计数是 n / 12，缩略图可点开预览', async () => {
  await wide.goto(`${base}/__preview-fixtures`);
  await wide.locator('#preview-trigger-many-1').click();
  await wide.locator('.preview-counter').getByText('2 / 12').waitFor();
  await wide.keyboard.press('Escape');
});

await check('A12', '混合组的可重试失败项有「重试」', async () => {
  await wide.goto(`${base}/__preview-fixtures`);
  await wide.locator('#preview-trigger-mixed-1').click();
  await viewer(wide).waitFor();
  await wide.getByRole('button', { name: '重试', exact: true }).waitFor();
  await wide.keyboard.press('Escape');
});

// 窄屏：楼中楼入口、评论计数入口、横向溢出。
const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();

await check('A6', '窄屏详情点「共25条回复」进入楼中楼（相关回复共25条 / 共3页）并返回', async () => {
  await phone.goto(`${base}/dynamics/90071992547409931`);
  await phone.getByRole('article').first().waitFor();
  await phone.getByRole('button', { name: '共25条回复' }).click();
  await phone.getByRole('heading', { name: '相关回复共25条' }).waitFor();
  await phone.getByRole('navigation', { name: '回复分页' }).getByText('共3页').waitFor();
  await phone.getByRole('button', { name: '返回评论' }).click();
  await phone.getByRole('region', { name: '评论区' }).waitFor();
});

await check('A13', '窄屏列表与图片夹具页无页面横向溢出', async () => {
  for (const path of ['/', '/__preview-fixtures', '/dynamics/90071992547409931']) {
    await phone.goto(`${base}${path}`);
    await phone.locator('main').waitFor();
    await phone.waitForTimeout(300);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`${path} 横向溢出 ${overflow}px`);
  }
});

await browser.close();

const failed = results.filter(result => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? '通过' : '失败'}  ${result.row.padEnd(8)} ${result.description}${result.ok ? '' : `\n        原因：${result.detail}`}`);
}
console.log(`\n清单自检：${results.length - failed.length} 通过 / ${failed.length} 失败（自动化 Chromium，不构成设备证据）`);
process.exit(failed.length === 0 ? 0 : 1);
