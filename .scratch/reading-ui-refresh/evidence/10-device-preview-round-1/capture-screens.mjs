// 票 10 第二轮的“待签收候选截图”，只取证、不是视觉签收，也不是黄金图。
// 环境 A（正式 dist 4318）真实页面：
//   1280×900：列表、管理列表、管理 UP 202
//   390×844 ：列表、管理列表、管理 UP 202、会话 960013（入口居中 + 唯一“刚才查看”）
// 明确不调用 pnpm visual:baseline / capture.spec / visual:golden，不读写 tests/visual-baseline。
// 用法：FRONTEND=<repo>/frontend SHOTS=<证据目录>/screens node capture-screens.mjs
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const frontend = process.env.FRONTEND;
if (!frontend) throw new Error('FRONTEND is required');
const shots = process.env.SHOTS;
if (!shots) throw new Error('SHOTS (output directory) is required');
const require = createRequire(`${frontend}/package.json`);
const { chromium } = require('@playwright/test');

const A = 'http://127.0.0.1:4318';
const CANDIDATE = '344235a';
const ROOT_ID = '860001';
const ENTRY_ID = '960013';
const targets = [
  { width: 1280, height: 900, key: 'list', url: `${A}/` },
  { width: 1280, height: 900, key: 'manage', url: `${A}/manage` },
  { width: 1280, height: 900, key: 'manage-202', url: `${A}/manage/ups/202` },
  { width: 390, height: 844, key: 'list', url: `${A}/` },
  { width: 390, height: 844, key: 'manage', url: `${A}/manage` },
  { width: 390, height: 844, key: 'manage-202', url: `${A}/manage/ups/202` },
  {
    width: 390, height: 844, key: 'conversation-960013',
    url: `${A}/dynamics/800300/comments/${ROOT_ID}/replies/${ENTRY_ID}/conversation`, conversation: true,
  },
];

mkdirSync(shots, { recursive: true });
const browser = await chromium.launch();
const captured = [];
try {
  for (const target of targets) {
    const context = await browser.newContext({ viewport: { width: target.width, height: target.height } });
    const page = await context.newPage();
    // 区分“整页文档导航”与“只读 API 读取”：两者路径都以 /conversation 结尾，
    // 旧版混在一个数组里会看起来像两次访问。这里分开记录，search 空表示没有分页参数。
    const conversationNavigations = [];
    const conversationApiReads = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.endsWith('/conversation')) return;
      const entry = { resourceType: request.resourceType(), path: url.pathname, search: url.search };
      if (url.pathname.startsWith('/api/')) conversationApiReads.push(entry);
      else conversationNavigations.push(entry);
    });
    const response = await page.goto(target.url, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { timeout: 15_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    let extra = {};
    if (target.conversation) {
      const list = page.getByRole('list', { name: '对话内容' });
      await list.waitFor({ timeout: 15_000 });
      const itemCount = await list.locator('> li').count();
      const marker = await page.getByText('刚才查看').count();
      const entryCount = await page.locator('[data-conversation-entry="true"]').count();
      let centerOffset = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        centerOffset = await page.evaluate(selector => {
          const element = document.querySelector(selector);
          if (!element) return Number.POSITIVE_INFINITY;
          const box = element.getBoundingClientRect();
          return Math.abs(box.top + box.height / 2 - window.innerHeight / 2);
        }, `[data-reading-id="reply:${ROOT_ID}:${ENTRY_ID}"]`);
        if (centerOffset <= 2) break;
        await page.waitForTimeout(100);
      }
      extra = {
        itemCount, markerCount: marker, entryCount,
        entryId: await page.locator('[data-conversation-entry="true"]').getAttribute('data-reading-id'),
        centerOffset: Math.round(centerOffset * 100) / 100,
        documentNavigations: conversationNavigations,
        apiReads: conversationApiReads,
      };
      if (itemCount !== 11 || marker !== 1 || entryCount !== 1 || centerOffset > 2) {
        throw new Error(`会话截图前置断言未满足：${JSON.stringify(extra)}`);
      }
    }
    const name = `${CANDIDATE}-${target.width}-${target.key}.png`;
    const path = join(shots, name);
    await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
    captured.push({
      name, path, width: target.width, height: target.height, url: target.url,
      candidate: CANDIDATE, viewportScreenshot: true,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      bytes: readFileSync(path).byteLength, responseStatus: response?.status(), ...extra,
    });
    console.log(`${name}  ${target.url}  ${readFileSync(path).byteLength} bytes${target.conversation ? `  居中偏差=${extra.centerOffset}px` : ''}`);
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(shots, 'index.json'), JSON.stringify({
  candidate: CANDIDATE,
  kind: 'round-1-candidate-screens-not-accepted',
  note: '待签收候选截图：视口截图，1280/390 两宽度；不是视觉签收，未更新黄金图。',
  screenshots: captured,
}, null, 2));
console.log(`screens index → ${join(shots, 'index.json')}`);
