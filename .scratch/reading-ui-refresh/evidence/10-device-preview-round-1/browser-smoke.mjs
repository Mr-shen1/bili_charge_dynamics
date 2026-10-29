// 票 10 第二轮隔离预览的轻量浏览器冒烟（准备用，不是视觉/真机验收，不产出黄金图）。
// 覆盖：
//   - A/B 两套预览都能渲染、/api 都打到 4180 的 live_app（仅 live_app 有 /api/test/source-requests）；
//   - A（正式 dist）没有归档图片，虚构头像 https://example.invalid/* 不可达且回落到本地默认头像；
//   - B（dist-mock 自检装配）的 /images 经 4339 受控夹具返回 200 且真的解码成功；
//   - 13 的会话页：390 宽下一次无 query 读取整段 11 条、无分页控件、唯一“刚才查看”、入口垂直居中。
// 用法：FRONTEND=<repo>/frontend node browser-smoke.mjs [out.json]
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const frontend = process.env.FRONTEND;
if (!frontend) throw new Error('FRONTEND is required');
const require = createRequire(`${frontend}/package.json`);
const { chromium } = require('@playwright/test');

const A = 'http://127.0.0.1:4318';
const B = 'http://127.0.0.1:4337';
const ROOT_ID = '860001';
const ENTRY_ID = '960013';
const CONVERSATION_PATH = `/dynamics/800300/comments/${ROOT_ID}/replies/${ENTRY_ID}/conversation`;

/** 每条目标：env / url / name / viewport / 会话断言（可选）。 */
const targets = [
  { env: 'A', url: `${A}/`, name: 'home', viewport: { width: 1280, height: 900 } },
  { env: 'A', url: `${A}/`, name: 'home-mobile', viewport: { width: 390, height: 844 } },
  { env: 'A', url: `${A}/dynamics/800300`, name: 'deep-dynamic', viewport: { width: 1280, height: 900 } },
  { env: 'A', url: `${A}${CONVERSATION_PATH}`, name: 'mobile-conversation', viewport: { width: 390, height: 844 }, conversation: true },
  { env: 'A', url: `${A}/manage`, name: 'manage-list', viewport: { width: 1280, height: 900 } },
  { env: 'A', url: `${A}/manage/ups/808`, name: 'manage-up', viewport: { width: 1280, height: 900 } },
  { env: 'B', url: `${B}/`, name: 'mock-home', viewport: { width: 1280, height: 900 } },
  { env: 'B', url: `${B}/__preview-fixtures`, name: 'mock-fixtures', viewport: { width: 1280, height: 900 } },
];

const assertions = [];
function check(scope, condition, detail) {
  assertions.push({ scope, ok: Boolean(condition), detail });
}

const browser = await chromium.launch();
const results = [];
try {
  for (const target of targets) {
    const context = await browser.newContext({ viewport: target.viewport });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const api = [];
    const images = [];
    const failedRequests = [];
    const conversationRequests = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)); });
    page.on('pageerror', error => pageErrors.push(String(error).slice(0, 200)));
    page.on('requestfailed', request => failedRequests.push({
      url: request.url(), failure: request.failure()?.errorText ?? '',
    }));
    page.on('request', request => {
      const url = new URL(request.url());
      // 只统计 XHR/fetch 的只读 API 读取；文档请求本身也以 /conversation 结尾，不算读取次数。
      if (url.pathname.startsWith('/api/') && url.pathname.endsWith('/conversation')) {
        conversationRequests.push({ path: url.pathname, search: url.search });
      }
    });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.pathname.startsWith('/api/')) api.push({ path: url.pathname, search: url.search, status: response.status() });
      else if (url.pathname.startsWith('/images/')) images.push({ path: url.pathname, status: response.status() });
    });

    const status = (await page.goto(target.url, { waitUntil: 'load' })).status();
    await page.waitForSelector('#app > *', { timeout: 15_000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    const rendered = await page.locator('#app *').count();
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    const imageStates = await page.evaluate(() => [...document.querySelectorAll('img')]
      .map(node => ({ src: node.getAttribute('src'), width: node.naturalWidth })));

    // 环境 A 的头像/封面是虚构主机 https://example.invalid/*：解析失败是已知环境限制。
    const unexpectedConsole = consoleErrors.filter(item => !item.startsWith('Failed to load resource'));
    const expectedHosts = failedRequests.filter(item => /^https:\/\/example\.invalid\//.test(item.url));
    const unexpectedFailed = failedRequests.filter(item => !/^https:\/\/example\.invalid\//.test(item.url));

    // /api/test/source-requests 只在 live_app 注册：代理落到 8000 会 404。两个环境都直接问一次。
    const probe = await page.request.get(`${new URL(target.url).origin}/api/test/source-requests`);
    check(`${target.env} ${target.name}`, probe.status() === 200,
      `代理目标探针 /api/test/source-requests → ${probe.status()}（200 = 4180 live_app）`);

    let conversation = null;
    if (target.conversation) {
      const list = page.getByRole('list', { name: '对话内容' });
      await list.waitFor({ timeout: 15_000 });
      const itemCount = await list.locator('> li').count();
      const countText = await page.getByText(`共 11 条`).count();
      const pager = await page.getByRole('navigation', { name: '回复分页' }).count();
      const nextPage = await page.getByRole('button', { name: '下一页' }).count();
      const marker = await page.getByText('刚才查看').count();
      const entry = page.locator('[data-conversation-entry="true"]');
      const entryCount = await entry.count();
      const entryId = entryCount ? await entry.getAttribute('data-reading-id') : null;
      const entryText = entryCount ? (await entry.innerText()).replace(/\s+/g, ' ') : '';
      let centerOffset = Number.POSITIVE_INFINITY;
      let scrollY = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        ({ centerOffset, scrollY } = await page.evaluate(selector => {
          const element = document.querySelector(selector);
          if (!element) return { centerOffset: Number.POSITIVE_INFINITY, scrollY: window.scrollY };
          const box = element.getBoundingClientRect();
          return {
            centerOffset: Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
            scrollY: window.scrollY,
          };
        }, `[data-reading-id="reply:${ROOT_ID}:${ENTRY_ID}"]`));
        if (centerOffset <= 2) break;
        await page.waitForTimeout(100);
      }
      conversation = {
        viewport: target.viewport, conversationRequests, itemCount, countText, pagerControls: pager,
        nextPageButtons: nextPage, markerCount: marker, entryCount, entryId, entryText,
        entryFaces: entryCount ? await entry.locator('img').evaluateAll(nodes => nodes.map(n => n.getAttribute('src'))) : [],
        centerOffset: Math.round(centerOffset * 100) / 100, scrollY: Math.round(scrollY),
      };
      const scope = `${target.env} ${target.name}`;
      check(scope, conversationRequests.length === 1 && conversationRequests[0].search === '',
        `会话请求 ${conversationRequests.length} 次，query='${conversationRequests.map(item => item.search).join(',')}'`);
      check(scope, itemCount === 11, `整段条目 ${itemCount} 条（期望 11）`);
      check(scope, countText === 1, `“共 11 条”出现 ${countText} 次`);
      check(scope, pager === 0 && nextPage === 0, `分页控件 ${pager} 个、下一页按钮 ${nextPage} 个（期望 0）`);
      check(scope, marker === 1, `“刚才查看”出现 ${marker} 次（期望 1）`);
      check(scope, entryCount === 1 && entryId === `reply:${ROOT_ID}:${ENTRY_ID}`,
        `入口标记 ${entryCount} 个，data-reading-id=${entryId}`);
      check(scope, centerOffset <= 2, `入口垂直中心偏差 ${conversation.centerOffset}px（期望 ≤2）`);
      check(scope, scrollY > 0, `滚动位置 scrollY=${Math.round(scrollY)}（期望 >0）`);
    }

    // 环境区分的图片断言：A 无归档图片、头像走 example.invalid 回落；B 的夹具图片必须 200 且解码。
    if (target.env === 'A') {
      check(`${target.env} ${target.name}`, images.length === 0,
        `A 的 /images 请求 ${images.length} 次（期望 0：归档无图片）`);
      check(`${target.env} ${target.name}`, unexpectedFailed.length === 0,
        `A 的意外失败请求 ${unexpectedFailed.length} 个：${unexpectedFailed.map(item => item.url).join(' ')}`);
      check(`${target.env} ${target.name}`, imageStates.every(item => item.src?.startsWith('/default-avatar.svg') && item.width > 0),
        `A 的 img：${[...new Set(imageStates.map(item => `${item.src}:${item.width}`))].join(' ')}`);
    } else {
      const okImages = images.filter(item => item.status === 200);
      const remoteImages = imageStates.filter(item => item.src?.startsWith('/images/'));
      // 只有 mock 首页内建了带归档图片的夹具；自检页本身不含图片，不要求有请求。
      check(`${target.env} ${target.name}`, images.length === okImages.length,
        `B 的 /images 响应：${images.map(item => `${item.path}:${item.status}`).join(' ') || '（无）'}`);
      check(`${target.env} ${target.name}`, remoteImages.every(item => item.width > 0),
        `B 的夹具图片解码：${remoteImages.map(item => `${item.src}:${item.width}`).join(' ') || '（无）'}`);
      check(`${target.env} ${target.name}`, target.name !== 'mock-home' || (okImages.length > 0 && remoteImages.length > 0),
        `B 首页夹具图片：${okImages.length} 个 200 响应 / ${remoteImages.length} 个已解码远程图片`);
      check(`${target.env} ${target.name}`, unexpectedFailed.length === 0,
        `B 的意外失败请求 ${unexpectedFailed.length} 个`);
    }

    results.push({
      env: target.env, name: target.name, url: target.url, viewport: target.viewport, status,
      renderedElements: rendered, textLength: text.length, textHead: text.slice(0, 160),
      consoleErrors: unexpectedConsole.length, consoleErrorTexts: unexpectedConsole,
      expectedFailedRequests: expectedHosts.length,
      expectedFailedUrls: [...new Set(expectedHosts.map(item => item.url))],
      unexpectedFailedRequests: unexpectedFailed.map(item => `${item.url} ${item.failure}`),
      pageErrors, apiRequests: api.length, apiStatuses: [...new Set(api.map(item => item.status))],
      apiPaths: [...new Set(api.map(item => item.path))],
      imageRequests: images.map(item => `${item.path}:${item.status}`),
      images: imageStates, conversation,
      proxyProbe: { path: '/api/test/source-requests', status: probe.status() },
    });
    await context.close();
  }
} finally {
  await browser.close();
}

const summary = { kind: 'browser-prep-smoke', checkedAt: new Date().toISOString(), assertions, targets: results };
const target = process.argv[2];
if (target) writeFileSync(target, JSON.stringify(summary, null, 2));
for (const result of results) {
  console.log(`${result.env} ${result.name} ${result.status} viewport=${result.viewport.width}x${result.viewport.height}` +
    ` 渲染=${result.renderedElements} 文本=${result.textLength}` +
    ` api=${result.apiRequests}(${result.apiStatuses.join('/') || '-'}) 图片=${result.imageRequests.join(',') || '-'}` +
    ` 控制台错误=${result.consoleErrors} 预期失败(example.invalid)=${result.expectedFailedRequests}` +
    ` 意外失败=${result.unexpectedFailedRequests.length} page错误=${result.pageErrors.length}`);
  if (result.conversation) {
    const c = result.conversation;
    console.log(`   会话：请求=${c.conversationRequests.map(item => item.search || '(无query)').join(',')}` +
      ` 条目=${c.itemCount} “共 11 条”=${c.countText} 分页=${c.pagerControls}/${c.nextPageButtons}` +
      ` “刚才查看”=${c.markerCount} 入口=${c.entryId} 居中偏差=${c.centerOffset}px scrollY=${c.scrollY}`);
  }
}
const failed = assertions.filter(item => !item.ok);
for (const item of failed) console.log(`FAIL ${item.scope}: ${item.detail}`);
console.log(`assertions: ${assertions.length - failed.length}/${assertions.length} pass`);
console.log(failed.length ? `browser smoke FAILED: ${[...new Set(failed.map(item => item.scope))].join(',')}` : 'browser smoke ok');
process.exit(failed.length ? 1 : 0);
