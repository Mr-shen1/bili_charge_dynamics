// #33 一次性证据附件；仅对既有活动生产站 GET，不启动服务、不构建、不注入产品样式/数据。
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir, copyFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve('.scratch/backend-integration/evidence/device-33/visual');
const stamp = new Date().toISOString().replaceAll(':', '-');
let output = root;
try { await access(join(root, 'conditions.json')); output = join(root, 'runs', stamp); } catch {}
await mkdir(output, { recursive: true });
const runtime = '/tmp/bili-device-33-xMpA6LHL';
const reference = join(runtime, 'visual-reference', stamp);
await mkdir(reference, { recursive: true });
const dataDirs = (await readdir(runtime)).filter(n => n.startsWith('data-'));
if (dataDirs.length !== 1) throw new Error('Expected exactly one active data directory; do not guess a service');
const publicDir = join(runtime, dataDirs[0], 'assets', 'visual-check');
await mkdir(publicDir, { recursive: true });
const baseURL = 'https://192.168.8.20:18443';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pngSize = bytes => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
const conditions = {
  startedAt: new Date().toISOString(), baseURL, repositoryHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  productFix: 'd2bbeef', expectedJS: 'index-DLXpqo1_.js',
  viewportWidths: [360, 390, 768, 1280], viewportHeight: 900, dpr: 1, zoom: '100%', timezone: 'Asia/Shanghai',
  mode: '现有生产归档 Adapter + 独立本地 SQLite/fixtures；仅 GET；串行；不使用 mockReader，不构建/不改 dist，不点击管理按钮，不修改 N/目标。',
  networkPolicy: '仅允许 GET 且 hostname 为 192.168.8.20 的浏览器网络请求；其他请求 abort；serviceWorkers block。没有替换 API/响应/图片。',
  fontProbe: { systemUI: execFileSync('fc-match', ['system-ui'], { encoding: 'utf8' }).trim(), chinese: execFileSync('fc-match', [':lang=zh-cn'], { encoding: 'utf8' }).trim() },
  reference: { directory: reference, scale: 0.5, reason: '动态作者头像来源约96图片px→48CSS px推定；不是来源已知DPR。',
    unknown: ['字体', 'CSS视口', 'DPR', '浏览器缩放'],
    missing: ['完整三条预览组／展开25条来源样本', '详情动态图片完整来源样本', '评论图片完整来源样本', '管理来源截图'],
    caution: '根头像来源框约97图片px，而当前40CSS px；可能存在装扮/框或量测差异，仅待核。业务内容不同，不作像素通过判定。', files: [], crops: [] },
  samples: [], regions: [], servedBuilds: {}, errors: [],
  userReportedContext: '用户补充：已提供Chrome UA/1920×965 DPR1并确认当前CachyOS，管理/布局步骤两端正常；本附件不重抄未取得的UA字符串，不冒充本轮自动化环境。仍无真机截图/Safari UA，不记像素通过。',
  limitations: ['来源裁区与实现元素矩形不共享同一DOM外边界，不能直接用裁片左/上留白判定页面缩进；应结合完整页面及相对头像锚点。', 'SRS默认预览3条与来源可见1条为内容/数量差异。实现第2/3条不隐藏，展开入口不搬动；整组高度不宣称相同。', '自动化 Chromium 不是 Linux Chrome/iPhone Safari 正式设备截图或人工像素签收。', '来源可见区域可比较；没有展开25条不妨碍比较可见单条回复。', '管理是同风格规则映射；本轮只读取初始 UI，未点击读取检查状态或任何写按钮。', '并排无拉伸、无遮罩；仅右/下最小补白，不产生通过率。'],
};
for (const name of ['dynamics-list.png', 'dynamic-detail.png']) {
  const path = join('docs/assets/ui-reference/current-35', name);
  const bytes = await readFile(path);
  conditions.reference.files.push({ path, sha256: hash(bytes), ...pngSize(bytes) });
  await copyFile(path, join(reference, name));
}
const browser = await chromium.launch();
conditions.browser = browser.version();
const context = await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 1, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block', locale: 'zh-CN' });
let active = null;
await context.route('**/*', async route => {
  const request = route.request(); const url = new URL(request.url());
  if (url.hostname === '192.168.8.20' && request.method() === 'GET') return route.continue();
  active?.blocked.push({ origin: url.origin, path: url.pathname, method: request.method() });
  return route.abort('blockedbyclient');
});
const buildTasks = [];
const page = await context.newPage();
page.on('pageerror', e => active?.pageErrors.push(e.message));
page.on('console', m => { if (m.type() === 'error') active?.consoleErrors.push(m.text()); });
page.on('request', r => active?.requests.push({ method: r.method(), path: new URL(r.url()).pathname }));
page.on('requestfailed', r => active?.requestFailures.push({ path: new URL(r.url()).pathname, error: r.failure()?.errorText }));
page.on('response', r => {
  const path = new URL(r.url()).pathname;
  if (r.status() >= 400) active?.httpErrors.push({ path, status: r.status() });
  if (/\/assets\/index-[^/]+\.js$/.test(path)) {
    buildTasks.push(r.body().then(bytes => { conditions.servedBuilds[path] = { sha256: hash(bytes), bytes: bytes.length }; }).catch(e => conditions.errors.push(`Build body: ${e.message}`)));
  }
});
async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.waitForLoadState('networkidle');
}
async function loadVisibleImages() {
  // 只滚动；不点击分页/展开，不替换内容。使实际存在的 lazy 缩略图进入加载范围。
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 650) {
      scrollTo(0, y); await new Promise(resolve => setTimeout(resolve, 60));
    }
    scrollTo(0, 0);
  });
  await settle();
}
const envelope = r => ({ x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.x + r.width) - Math.floor(r.x), height: Math.ceil(r.y + r.height) - Math.floor(r.y) });
async function captureRegion(name, rect, extra = {}) {
  const clip = envelope(rect); const file = `${name}.png`;
  // clip使用文档坐标；开启fullPage，避免视口下方评论裁区被截为空。
  await page.screenshot({ path: join(output, file), fullPage: true, clip });
  conditions.regions.push({ name, file, rect, clip, png: pngSize(await readFile(join(output, file))), ...extra });
}
try {
  for (const width of conditions.viewportWidths) {
    for (const [name, path] of [['list', '/ups/740'], ['scope', '/ups/710'], ['detail', '/dynamics/710001'], ['manage', '/manage']]) {
      active = { name, path, width, height: 900, startedAt: new Date().toISOString(), blocked: [], requests: [], requestFailures: [], httpErrors: [], pageErrors: [], consoleErrors: [] };
      conditions.samples.push(active);
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(baseURL + path, { waitUntil: 'load' });
        if (name === 'manage') await page.getByRole('article', { name: 'UP 710', exact: true }).waitFor();
        else await page.getByRole('article').first().waitFor();
        if (name === 'detail') await page.locator('[data-reading-id^="reply:710001001:"]').nth(2).waitFor();
        await loadVisibleImages();
        const snapshot = () => page.evaluate(() => {
          const main = document.querySelector('main');
          return { main: main.getBoundingClientRect().toJSON(), scrollHeight: document.documentElement.scrollHeight,
            images: [...document.images].map(i => ({ path: i.currentSrc ? new URL(i.currentSrc).pathname : null, complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight })) };
        });
        const before = await snapshot();
        await page.waitForTimeout(400);
        const after = await snapshot();
        Object.assign(active, after, { layoutAndImagesStable: JSON.stringify(before) === JSON.stringify(after) });
        Object.assign(active, await page.evaluate(() => {
          const main = document.querySelector('main'); const style = getComputedStyle(main);
          return { userAgent: navigator.userAgent, font: { status: document.fonts.status, family: style.fontFamily,
            size: style.fontSize, lineHeight: style.lineHeight, faces: [...document.fonts].map(f => ({ family: f.family, status: f.status })),
            probes: Object.fromEntries(['Arial', 'Noto Sans CJK SC', 'sans-serif', 'system-ui'].map(f => [f, document.fonts.check(`16px "${f}"`, '中文Ab')])) },
            document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, innerWidth, overflow: document.documentElement.scrollWidth > innerWidth },
            display: { dpr: devicePixelRatio, visualViewportScale: visualViewport?.scale, cssZoom: getComputedStyle(document.documentElement).zoom },
            scripts: [...document.scripts].map(s => new URL(s.src).pathname),
            roots: document.querySelectorAll('[data-reading-id^="comment:"]').length,
            root710001001VisibleReplies: document.querySelectorAll('[data-reading-id^="reply:710001001:"]').length,
            uiAlerts: [...document.querySelectorAll('[role="alert"]')].map(e => e.textContent),
          };
        }));
        active.jsMatchesExpected = active.scripts.includes(`/assets/${conditions.expectedJS}`);
        if (!active.jsMatchesExpected) throw new Error(`Unexpected production bundle; do not label this capture as ${conditions.productFix}`);
        active.file = `${name}-${width}.png`;
        active.capturedAt = new Date().toISOString();
        await page.screenshot({ path: join(output, active.file), fullPage: true });
        active.png = pngSize(await readFile(join(output, active.file)));
        active.fullScreenshotCompleted = true;
        if (width === 1280 && name === 'detail') {
          await page.evaluate(() => scrollTo(0, 0));
          const rects = await page.evaluate(() => {
            const root = document.querySelector('[data-reading-id="comment:710001001"]');
            const section = root.querySelector('[aria-label="回复区 710001001"]');
            const reply = section.querySelector('[data-reading-id^="reply:710001001:"]');
            const entry = section.querySelector('button[aria-label="展开回复"]');
            const r = e => e.getBoundingClientRect().toJSON();
            return { root: r(root), section: r(section), reply: r(reply), entry: r(entry), entryText: entry.textContent,
              rootAvatar: r(root.querySelector('[data-display-identity] img')), replyAvatar: r(reply.querySelector('img')),
              replyTime: r(reply.querySelector('time')), replyLike: r(reply.querySelector('[role="group"]')) };
          });
          active.regionDOM = rects;
          await captureRegion('root-comment-region', { x: rects.root.x, y: rects.root.y, width: rects.root.width, height: rects.section.y - rects.root.y }, { rule: '公开根li顶端至回复section顶端，排除全部嵌套回复；保留前置间距。' });
          await captureRegion('single-reply-region', rects.reply, { rule: '完整第一条可见回复li；包含身份/正文/时间/只读点赞；未点击展开。' });
          await captureRegion('reply-entry-region', rects.entry, { text: rects.entryText });
          await captureRegion('reply-preview-group-region', rects.section, { rule: '实际三条预览及入口整体保留；来源只有一条，不作为同数量对齐。' });
        }
      } catch (error) {
        active.captureError = error.message; conditions.errors.push(`${name}-${width}: ${error.message}`);
      }
      active.finishedAt = new Date().toISOString();
      console.log(JSON.stringify({ name, width, file: active.file, overflow: active.document?.overflow, stable: active.layoutAndImagesStable, error: active.captureError ?? null }));
    }
  }
  await Promise.all(buildTasks);
  active = null;
  // 仅本地base64 PNG经canvas处理；此页不是产品入口，不访问任何外部图源。
  const canvasPage = await context.newPage(); await canvasPage.setContent('<!doctype html><meta charset="utf-8"><title>本地图像处理</title>');
  const detailBytes = await readFile(join(reference, 'dynamic-detail.png'));
  const crops = [
    ['root-comment', [110, 1210, 1320, 1390], 'root-comment-region.png', '代理按本地参考图定位的根评论本体矩形，非用户签收'],
    ['single-reply', [110, 1410, 1320, 1580], 'single-reply-region.png', '代理按本地参考图拆分：保留完整身份、两行正文、时间和操作；y1580为空白分界，非用户签收'],
    ['reply-entry', [110, 1580, 1320, 1670], 'reply-entry-region.png', '代理按本地参考图拆分的回复组余下区域，包含共9条回复入口及底部分隔，非用户签收'],
    ['reply-preview-group', [110, 1410, 1320, 1670], 'reply-preview-group-region.png', '代理按本地参考图定位的可见组：一条完整回复及共9条回复入口；非用户签收，不是3或25条'],
  ];
  for (const [name, rect, implFile, basis] of crops) {
    const implementation = await readFile(join(output, implFile));
    const result = await canvasPage.evaluate(async ({ source, impl, rect }) => {
      const load = src => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = `data:image/png;base64,${src}`; });
      const [s, i] = await Promise.all([load(source), load(impl)]);
      const [x0, y0, x1, y1] = rect;
      const crop = document.createElement('canvas'); crop.width = x1-x0; crop.height = y1-y0;
      crop.getContext('2d').drawImage(s, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
      const normalized = document.createElement('canvas'); normalized.width = crop.width * 0.5; normalized.height = crop.height * 0.5;
      normalized.getContext('2d').drawImage(crop, 0, 0, normalized.width, normalized.height);
      const cell = { width: Math.max(normalized.width, i.width), height: Math.max(normalized.height, i.height) };
      const pair = document.createElement('canvas'); pair.width = cell.width*2; pair.height = cell.height;
      const p = pair.getContext('2d'); p.fillStyle = 'white'; p.fillRect(0, 0, pair.width, pair.height);
      p.drawImage(normalized, 0, 0); p.drawImage(i, cell.width, 0);
      const data = c => c.toDataURL('image/png').split(',')[1];
      return { crop: data(crop), normalized: data(normalized), pair: data(pair), cell,
        sourceNormalized: { width: normalized.width, height: normalized.height }, implementation: { width: i.width, height: i.height } };
    }, { source: detailBytes.toString('base64'), impl: implementation.toString('base64'), rect });
    for (const [key, file] of [['crop', `${name}-source-crop.png`], ['normalized', `${name}-source-0.5.png`], ['pair', `${name}-side-by-side.png`]]) {
      await writeFile(join(reference, file), Buffer.from(result[key], 'base64'));
      if (key !== 'crop') await copyFile(join(reference, file), join(publicDir, file));
    }
    // 沿用旧视觉入口的白色右/下补齐及 ImageMagick difference 规则；不导入有顶层采集副作用的 CLI。
    const extent = `${result.cell.width}x${result.cell.height}`;
    const differenceFile = join(reference, `${name}-difference.png`);
    execFileSync('magick', [
      '(', join(reference, `${name}-source-0.5.png`), '-background', 'white', '-gravity', 'northwest', '-extent', extent, ')',
      '(', join(output, implFile), '-background', 'white', '-gravity', 'northwest', '-extent', extent, ')',
      '-compose', 'difference', '-composite', differenceFile,
    ]);
    await copyFile(differenceFile, join(publicDir, `${name}-difference.png`));
    conditions.reference.crops.push({ name, rectXYXY: rect, basis, source: 'dynamic-detail.png', scale: 0.5,
      normalized: result.sourceNormalized, implementation: result.implementation, cell: result.cell,
      padding: '左右各一格；只在各图右/下补至两侧最小共同画布；实现未缩放；无内容/图标遮罩。',
      normalizedFile: join(reference, `${name}-source-0.5.png`), pairFile: join(reference, `${name}-side-by-side.png`),
      differenceFile, differenceRule: 'ImageMagick difference；左上对齐原始帧差，无配准、遮罩、阈值或通过率；裁区边缘不等于同一DOM边界。' });
  }
  await canvasPage.close();
  // 临时页与所有原图衍生品均只写 /tmp，不进入仓库。
  const implementationFiles = (await readdir(output)).filter(n => n.endsWith('.png'));
  for (const file of implementationFiles) await copyFile(join(output, file), join(publicDir, file));
  const image = (file, alt, width) => `<div class="scroll"><img src="./${file}" alt="${alt}"${width ? ` width="${width}"` : ''}></div>`;
  const titles = { 'root-comment': '根评论本体（排除回复）', 'single-reply': '单条完整可见回复', 'reply-entry': '回复展开入口', 'reply-preview-group': '回复组上下文（来源1条、实现3条，不同数量）' };
  const comparisons = conditions.reference.crops.map(c => `<section><h2>${titles[c.name]}</h2><p>左：来源0.5归一 ${c.normalized.width}×${c.normalized.height}；右：实现原尺寸 ${c.implementation.width}×${c.implementation.height}。右/下补白，无遮罩。</p>${image(`${c.name}-side-by-side.png`, titles[c.name], c.cell.width*2)}<p>原始帧差：左上对齐白色补齐后的 ImageMagick difference，无配准／遮罩／阈值。角色、文字及裁片起点不同都会形成差分，不等同于布局缺陷或像素签收。</p>${image(`${c.name}-difference.png`, `${titles[c.name]}原始帧差`, c.cell.width)}</section>`).join('\n');
  const full = conditions.samples.filter(s => s.fullScreenshotCompleted).map(s => `<details><summary>${({ list: '740单卡双图', scope: '710单UP', detail: '710001纯文详情', manage: '管理只读' })[s.name]} / ${s.width}×900，完整PNG ${s.png.width}×${s.png.height}，页面横溢出：${s.document.overflow ? '有' : '无'}</summary><p><a href="./${s.file}">打开完整实现PNG</a>（不缩放，横向滚动）</p>${image(s.file, `${s.name} ${s.width}`, s.png.width)}</details>`).join('\n');
  const regionDOM = conditions.samples.find(s => s.name === 'detail' && s.width === 1280)?.regionDOM;
  const replyIndent = regionDOM ? regionDOM.replyAvatar.x - regionDOM.rootAvatar.x : '未取得';
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>#33 临时视觉对照（待人工核验）</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;line-height:1.7;color:#252a30;background:#edf7f8}section,details,header{background:white;padding:16px;margin:16px 0;border:1px solid #dbe5e8}h1{font-size:24px}h2{font-size:20px}.scroll{overflow:auto;max-width:100%;background:white}img{display:block;max-width:none;height:auto}summary{cursor:pointer}code{overflow-wrap:anywhere}a{color:#007b9f}</style></head><body><header><h1>#33 临时视觉对照：未签收</h1><p>来源按动态作者头像96→48推定 <strong>0.5等比归一是假设基准，不是已知DPR</strong>。来源字体/视口/缩放未知；双方内容不同，不代表一比一已通过。</p><p>根评论与【单条可见回复】分别看比例、间距、字和图标。当前单条裁片是来源UP回复对实现首条普通读者，角色不同导致昵称颜色和UP徽标不同，不能据此判为同角色风格差异；核对UP样式时看下方完整实现预览组中的第2条UP回复。来源回复预览组只有一条完整可见回复及“共9条回复”入口，不是3条或25条。本项目按SRS默认预览3条，是须保留的内容/数量差异：不隐藏实现第2/3条、不搬动入口，不声明整组等高。可见区域可以比较，不能因没有25条来源就跳过。根头像来源框约97图片px、实现40CSS px，可能装扮/框或量测差异，仅列待核，不改CSS。</p><p>完整三条预览组／展开25条、详情动态图片及评论图片没有完整来源样本，不自造来源。管理是同规则映射，没有来源管理页截图；本轮仅读取管理初始受控UI，不点击写操作，不改N/目标。用户补充Chrome UA/1920×965 DPR1、当前CachyOS及管理/布局两端正常的信息，仅为用户自述；仍无真机截图/Safari UA。自动化截图不是两设备正式截图或人工像素签收。</p><p>实现四宽度原尺寸显示，可横滚；并排只右/下最小补白，不为相似缩放实现，不遮罩容器或图标。来源裁区与实现元素矩形不共享同一DOM外边界，不能直接用裁片左/上留白判定页面缩进；需结合完整页面和条件文件内相对锚点。当前实现回复头像相对根头像水平缩进为 ${replyIndent} CSS px。裁区由代理按本地原图定位，不是用户像素签收。未提供完整列表/详情来源并排：两张来源仅作本地哈希记录，当前独立对照聚焦根评论、单条回复和入口。</p><p>生产JS：<code>${conditions.expectedJS}</code>；产品修复${conditions.productFix}；采集开始：${conditions.startedAt}。本页无外链，图片/元数据均在本目录。<a href="./conditions.json">本轮条件与观察</a></p></header>${comparisons}<section><h2>四页面×四宽度：完整实现截图</h2><p>仅打开折叠项查看，不裁切、缩放或修改产品截图。页面横滚容器是对照工具，不是产品页面overflow结果。</p>${full}</section></body></html>`;
  await writeFile(join(publicDir, 'index.html'), html);
  conditions.comparisonPage = `${baseURL}/visual-assets/visual-check/index.html`;
  conditions.publicDirectory = publicDir;
  conditions.completedFullScreenshots = conditions.samples.filter(s => s.fullScreenshotCompleted).length;
} catch (error) {
  conditions.errors.push(error.stack ?? error.message);
} finally {
  conditions.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'conditions.json'), JSON.stringify(conditions, null, 2) + '\n');
  await copyFile(join(output, 'conditions.json'), join(publicDir, 'conditions.json'));
  await browser.close();
  console.log(JSON.stringify({ output, reference, comparisonPage: conditions.comparisonPage, screenshots: conditions.completedFullScreenshots, errors: conditions.errors }, null, 2));
}
if (conditions.errors.length) process.exitCode = 1;
