// 票 10 隔离预览的轻量浏览器冒烟（准备用）：headless Chromium 载入各页，只记录
// “页面能渲染出内容、控制台无报错、/api 与 /images 响应状态”，不是视觉/真机验收，
// 也不产出截图与黄金图。用法：FRONTEND=<repo>/frontend node browser-smoke.mjs [out.json]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const frontend = process.env.FRONTEND;
if (!frontend) throw new Error('FRONTEND is required');
const require = createRequire(`${frontend}/package.json`);
const { chromium } = require('@playwright/test');

const targets = [
  ['A', 'http://127.0.0.1:4318/', 'home'],
  ['A', 'http://127.0.0.1:4318/dynamics/800300', 'deep-dynamic'],
  ['A', 'http://127.0.0.1:4318/dynamics/800300/comments/860001/replies/960013/conversation', 'deep-conversation'],
  ['A', 'http://127.0.0.1:4318/manage', 'manage-list'],
  ['A', 'http://127.0.0.1:4318/manage/ups/808', 'manage-up'],
  ['B', 'http://127.0.0.1:4337/', 'mock-home'],
  ['B', 'http://127.0.0.1:4337/__preview-fixtures', 'mock-fixtures'],
];

const browser = await chromium.launch();
const results = [];
try {
  for (const [env, url, name] of targets) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const api = [];
    const images = [];
    const failedRequests = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
    page.on('pageerror', error => pageErrors.push(String(error).slice(0, 200)));
    // 资源失败按 URL 归类：环境 A 的头像/封面是虚构主机 https://example.invalid/*，
    // 解析失败属于已记录的环境限制，不算页面缺陷。
    page.on('requestfailed', request => failedRequests.push({
      url: request.url(), failure: request.failure()?.errorText ?? '',
    }));
    page.on('response', response => {
      const target = new URL(response.url()).pathname;
      if (target.startsWith('/api/')) api.push({ path: target, status: response.status() });
      else if (target.startsWith('/images/')) images.push({ path: target, status: response.status() });
    });
    const status = (await page.goto(url, { waitUntil: 'load' })).status();
    await page.waitForSelector('#app > *', { timeout: 15_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    const rendered = await page.locator('#app *').count();
    // 受控图片是否真的解码成功（B 才有 /images 夹具）。
    const imageStates = await page.evaluate(async () => {
      const nodes = [...document.querySelectorAll('img')];
      return nodes.map(node => ({ src: node.getAttribute('src'), width: node.naturalWidth }));
    });
    // 环境 A 的头像/封面是 https://example.invalid/*（虚构主机）：解析失败是预期的环境限制，
    // 单独归类，不能算页面缺陷；其余控制台错误一律如实记录。
    // 通用 “Failed to load resource” 由 requestfailed 里的 URL 判定归属，这里只留非资源类错误。
    const unexpectedConsole = consoleErrors.filter(item => !item.startsWith('Failed to load resource'));
    const expectedHosts = failedRequests.filter(item => /^https:\/\/example\.invalid\//.test(item.url));
    const unexpectedFailed = failedRequests.filter(item => !/^https:\/\/example\.invalid\//.test(item.url));
    results.push({
      env, name, url, status, renderedElements: rendered, textLength: text.length,
      textHead: text.slice(0, 160),
      consoleErrors: unexpectedConsole.length, consoleErrorTexts: unexpectedConsole,
      expectedFailedRequests: expectedHosts.length,
      unexpectedFailedRequests: unexpectedFailed.map(item => `${item.url} ${item.failure}`),
      pageErrors, apiRequests: api.length, apiStatuses: [...new Set(api.map(item => item.status))],
      imageRequests: images.map(item => `${item.path}:${item.status}`),
      images: imageStates,
    });
    await context.close();
  }
} finally {
  await browser.close();
}

const summary = { kind: 'browser-prep-smoke', targets: results };
const target = process.argv[2];
if (target) writeFileSync(target, JSON.stringify(summary, null, 2));
for (const result of results) {
  console.log(`${result.env} ${result.name} ${result.status} 渲染=${result.renderedElements} 文本=${result.textLength}` +
    ` api=${result.apiRequests}(${result.apiStatuses.join('/') || '-'}) 图片=${result.imageRequests.join(',') || '-'}` +
    ` 控制台错误=${result.consoleErrors} 预期失败(example.invalid)=${result.expectedFailedRequests}` +
    ` 意外失败=${result.unexpectedFailedRequests.length} page错误=${result.pageErrors.length}`);
  for (const text of result.consoleErrorTexts) console.log(`   ! ${text}`);
  for (const text of result.unexpectedFailedRequests) console.log(`   ! ${text}`);
  console.log(`   ${result.textHead}`);
}
const failed = results.filter(result => result.status !== 200 || result.renderedElements === 0
  || result.consoleErrors > 0 || result.pageErrors.length > 0 || result.unexpectedFailedRequests.length > 0 || result.apiStatuses.some(status => status >= 500));
console.log(failed.length ? `browser smoke FAILED: ${failed.map(item => item.name).join(',')}` : 'browser smoke ok');
process.exit(failed.length ? 1 : 0);
