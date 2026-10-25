// 票据 14：新版视觉受控截图。截图只取证，不代表用户已签收；签收由证据文档单独登记。
// 运行：pnpm visual:baseline（先 pnpm build，再跑本配置的四个宽度）。
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import {
  dynamicIds, emptyCommentsDynamicId, mainDynamicId, pendingCommentsDynamicId, rootWithoutReplies, rootWithReplies,
} from './fixtures';
import {
  SCREENSHOT_DIR, VIEWPORT_HEIGHT, VIEWPORTS, capture, collectedSamples, expectNoPageOverflow,
  prepareOutputDirectory, resetSamples, settle, stubArchive, stubImages, writeConditions, type ArchiveFaults,
} from './support';

const artifacts: Record<string, unknown> = {};
let browserVersion = '';

async function buildIdentity() {
  const assets = join(process.cwd(), 'dist', 'assets');
  const files = (await readdir(assets)).filter(name => name.endsWith('.js') || name.endsWith('.css')).sort();
  const entries = [];
  for (const file of files) {
    const bytes = await readFile(join(assets, file)).catch(() => null);
    if (!bytes) continue;
    entries.push({ file, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return entries;
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf8' }).trim();
}

async function openArchive(page: Page, url: string, faults: ArchiveFaults = {}): Promise<void> {
  await page.unroute('**/api/archive/**');
  await stubArchive(page, faults);
  await page.goto(url);
}

async function waitForThumbnails(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('.image-grid__thumb img')];
    return images.length > 0 && images.every(image => image.complete);
  }, undefined, { timeout: 10_000 });
}

async function scrollToComments(page: Page): Promise<void> {
  await page.locator('.comment-section').evaluate(node =>
    node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect(page.locator('.comment-section')).toBeVisible();
  await page.waitForTimeout(200);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // 先记录源码状态，再清空输出目录；否则截图目录自身的删除会混进 sourceStatus。
  artifacts['build'] = await buildIdentity();
  artifacts['sourceCommit'] = git(['rev-parse', 'HEAD']);
  artifacts['sourceStatus'] = git(['status', '--porcelain']).split('\n')
    .filter(Boolean)
    // .pi/ 是代理工具配置，截图目录是本次输出：两者不属于候选源码，其余未提交文件仍如实记录。
    .filter(line => !line.includes('.pi/') && !line.includes('evidence/visual-14/'));
  await prepareOutputDirectory();
  resetSamples();
});

test('归档阅读场景与四宽度截图', async ({ page }) => {
  browserVersion = page.context().browser()?.version() ?? 'unknown';
  await stubImages(page);

  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });

    // 列表：全部归档选中，长正文折叠，图片组与评论入口可见。
    await openArchive(page, '/');
    await expect(page.getByRole('article')).toHaveCount(10);
    await expect(page.getByRole('link', { name: '全部归档' })).toHaveAttribute('aria-current', 'page');
    await waitForThumbnails(page);
    await capture(page, `list-${width}`);

    // 单 UP：选中态、卡片作者与归档内容。
    await openArchive(page, '/ups/1002');
    await expect(page.getByRole('article')).toHaveCount(2);
    await expect(page.getByRole('link', { name: /夜航岛/ })).toHaveAttribute('aria-current', 'page');
    await capture(page, `list-scope-${width}`);

    // 详情：正文全文展示（不折叠）与完整图片组。
    await openArchive(page, `/dynamics/${mainDynamicId}`);
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect(page.locator('.detail-card')).toBeVisible();
    await waitForThumbnails(page);
    await capture(page, `detail-${width}`);

    // 一级评论：排序、折叠、评论图片与回复入口。
    await scrollToComments(page);
    await expect(page.getByRole('list', { name: '一级评论' })).toBeVisible();
    await waitForThumbnails(page);
    await capture(page, `comments-${width}`);

    // 图片预览：库原生查看器 + 应用计数。
    await openArchive(page, `/dynamics/${mainDynamicId}`);
    await page.locator(`#preview-trigger-dynamic-${mainDynamicId}-0`).click();
    await expect(page.locator('.el-image-viewer__wrapper')).toBeVisible();
    await expect(page.locator('.preview-counter')).toHaveText('1 / 4');
    await page.waitForTimeout(300);
    await capture(page, `preview-${width}`);
    await page.keyboard.press('Escape');

    // 宽屏回复：内联预览 3 条，展开后实时页码每页 10 条。
    if (width >= 768) {
      await openArchive(page, `/dynamics/${mainDynamicId}`);
      await scrollToComments(page);
      await page.getByRole('button', { name: '展开回复', exact: true }).first().click();
      await expect(page.getByRole('button', { name: '收起', exact: true })).toBeVisible();
      await expect(page.locator('.reply').first()).toBeVisible();
      await page.waitForTimeout(300);
      await capture(page, `replies-${width}`);
    }

    // 窄屏独立楼中楼：根评论 + 实时页码回复列表。
    if (width < 768) {
      await openArchive(page, `/dynamics/${mainDynamicId}/comments/${rootWithReplies}`);
      await expect(page.getByRole('heading', { name: /相关回复共25条/ })).toBeVisible();
      await expect(page.getByRole('list', { name: '相关回复' })).toBeVisible();
      await capture(page, `thread-${width}`);
    }

    // 预览错误态：可重试的浏览器加载失败。
    if (width === 390 || width === 1280) {
      await openArchive(page, `/dynamics/${dynamicIds[3]}`);
      await page.locator(`#preview-trigger-dynamic-${dynamicIds[3]}-4`).click();
      await expect(page.locator('.preview-error')).toContainText('图片加载失败');
      await page.waitForTimeout(300);
      await capture(page, `preview-error-${width}`);
      await page.keyboard.press('Escape');
    }
  }
});

test('归档空态与错误态', async ({ page }) => {
  await stubImages(page);
  const states: readonly {
    name: string; url: string; faults?: ArchiveFaults; widths: readonly number[]; prepare?: (page: Page) => Promise<void>;
  }[] = [
    { name: 'list-empty', url: '/', faults: { listEmpty: true }, widths: [390, 1280] },
    { name: 'list-error', url: '/', faults: { listError: true }, widths: [390, 1280] },
    { name: 'up-unknown', url: '/ups/999', faults: { unknownUp: true }, widths: [390, 1280] },
    { name: 'up-strip-error', url: '/', faults: { upsError: true }, widths: [390, 1280] },
    { name: 'detail-not-found', url: '/dynamics/123456', faults: { detailNotFound: true }, widths: [390, 1280] },
    { name: 'detail-error', url: `/dynamics/${mainDynamicId}`, faults: { detailError: true }, widths: [390, 1280] },
    { name: 'comments-empty', url: `/dynamics/${emptyCommentsDynamicId}`, widths: [390, 1280], prepare: scrollToComments },
    { name: 'comments-pending', url: `/dynamics/${pendingCommentsDynamicId}`, widths: [390, 1280], prepare: scrollToComments },
    { name: 'comments-error', url: `/dynamics/${mainDynamicId}`, faults: { commentsError: true }, widths: [390, 1280], prepare: scrollToComments },
    { name: 'replies-empty', url: `/dynamics/${mainDynamicId}/comments/${rootWithoutReplies}`, widths: [390], faults: { repliesEmpty: true } },
    { name: 'replies-error', url: `/dynamics/${mainDynamicId}/comments/${rootWithReplies}`, widths: [390], faults: { repliesError: true } },
  ];

  for (const state of states) {
    for (const width of state.widths) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await openArchive(page, state.url, state.faults);
      await settle(page);
      if (state.prepare) await state.prepare(page);
      // 空/错态也要满足四宽度无横溢，不能只当截图素材。
      await expectNoPageOverflow(page, `${width}px ${state.name}`);
      await capture(page, `${state.name}-${width}`);
    }
  }
});

test('管理列表与单 UP 管理截图（实际 API + 隔离 SQLite）', async ({ page, request }) => {
  await stubImages(page);
  // 受控资料：两个 UP 已启用，一个指定模式带目标；全部通过隔离 API 写入。
  for (const uid of ['202', '900719925474099312345', '707']) {
    const created = await request.post('/api/manage/ups', { data: { uid } });
    expect(created.status(), `新增 UP ${uid}`).toBe(201);
  }
  await request.patch('/api/manage/ups/202/monitor', { data: { mode: 'recent', recent_n: 10, enabled: true } });
  await request.patch('/api/manage/ups/900719925474099312345/monitor', {
    data: { mode: 'recent', recent_n: 25, enabled: true },
  });
  await request.patch('/api/manage/ups/707/monitor', { data: { mode: 'specified', recent_n: 10, enabled: false } });
  const target = await request.post('/api/manage/ups/707/targets', { data: { id: '900707' } });
  expect(target.status(), '关联指定目标').toBe(201);

  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await page.goto('/manage');
    await expect(page.getByRole('list', { name: 'UP 列表' })).toBeVisible();
    await capture(page, `manage-${width}`);

    await page.goto('/manage/ups/202');
    await expect(page.getByRole('article', { name: 'UP 202' })).toBeVisible();
    // 读取检查与发现状态：读取按钮、空记录与状态面板都在同一张截图里。
    await page.getByRole('button', { name: '读取检查状态', exact: true }).click();
    await expect(page.getByRole('region', { name: '目标检查与归档状态' })).toContainText('尚无目标检查记录');
    await page.getByRole('button', { name: '读取发现状态', exact: true }).click();
    await expect(page.getByRole('region', { name: '近期发现与当前窗口' }))
      .toContainText('尚无完整成功的可信发现结果');
    // 读取按钮可能把页面滚到中部；代表截图固定从身份卡顶部开始。
    await page.evaluate(() => window.scrollTo(0, 0));
    await capture(page, `up-${width}`);

    if (width === 390 || width === 1280) {
      await page.goto('/manage/ups/707');
      await expect(page.getByRole('article', { name: 'UP 707' })).toBeVisible();
      await expect(page.locator('.manage-target-id')).toHaveText('900707');
      await capture(page, `up-specified-${width}`);
    }
  }
});

test('管理空态与错误态', async ({ page }) => {
  const states: readonly {
    name: string; url: string; status: number; body: unknown; contentType?: string; widths: readonly number[];
  }[] = [
    { name: 'manage-empty', url: '/manage', status: 200, body: { ups: [] }, widths: [390, 1280] },
    {
      name: 'manage-error', url: '/manage', status: 503,
      body: { error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, widths: [390, 1280],
    },
    {
      name: 'manage-unauthorized', url: '/manage', status: 401,
      body: '<html><h1>Unauthorized</h1>PRIVATE_PROXY_DETAIL</html>', widths: [1280],
    },
    {
      name: 'up-not-found', url: '/manage/ups/404404', status: 404,
      body: { error: { code: 'NOT_FOUND' } }, widths: [390, 1280],
    },
  ];

  for (const state of states) {
    for (const width of state.widths) {
      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
      await page.unroute('**/api/manage/**');
      await page.route('**/api/manage/**', route => route.fulfill({
        status: state.status,
        contentType: state.contentType ?? (typeof state.body === 'string' ? 'text/html' : 'application/json'),
        body: typeof state.body === 'string' ? state.body : JSON.stringify(state.body),
      }));
      await page.goto(state.url);
      await expect(page.locator('.manage-shell')).toBeVisible();
      await expect(page.locator('.el-alert, .manage-notice, [role="status"]').first()).toBeVisible();
      await capture(page, `${state.name}-${width}`);
    }
  }
  await page.unroute('**/api/manage/**');
});

function resolvedFont(): string {
  try {
    return execFileSync('fc-match', ['system-ui'], { encoding: 'utf8' }).trim();
  } catch {
    return 'fc-match 不可用';
  }
}

test.afterAll(async () => {
  await writeConditions({
    ticket: '14',
    scope: 'Vue 新版视觉受控截图（未签收；签收范围与反馈单独登记）',
    artifacts,
    sourceNote: '截图产生于本次改动提交前的工作树；sourceCommit 为当时的 HEAD，sourceStatus 列出未提交改动。'
      + '最终提交与产物标识以 evidence/14-visual-baseline-preparation.md 登记为准。',
    environment: {
      browser: `Chromium ${browserVersion}`,
      playwrightVersion: JSON.parse(
        await readFile(join(process.cwd(), 'node_modules', '@playwright', 'test', 'package.json'), 'utf8'),
      ).version,
      node: process.version,
      deviceScaleFactor: 1,
      zoom: '100%（浏览器默认缩放，未注入 zoom/CSS transform）',
      viewportHeights: VIEWPORT_HEIGHT,
      widths: VIEWPORTS,
      timezoneId: 'Asia/Shanghai',
      locale: 'zh-CN',
      reducedMotion: 'no-preference',
      fontFamily: 'system-ui, -apple-system, Noto Sans SC, sans-serif（见 src/theme/theme.css）',
      resolvedFont: resolvedFont(),
      screenshot: 'Playwright page.screenshot，视口截图（非整页），animations=disabled，caret=hide',
    },
    content: {
      archive: 'page.route 提供固定 DTO 与固定 SVG 图片，经生产 Adapter 映射；不访问真实来源或图片服务器',
      manage: 'backend/tests/live_app 虚构上游 + 本次运行独占 SQLite；状态面板来自实际只读接口',
      errorStates: 'HTTP 替身返回 404/503/401，页面按自身错误文案呈现',
    },
    screenshots: collectedSamples(),
    directory: SCREENSHOT_DIR,
    caveats: [
      '截图不代表用户视觉签收；未签收前不建立黄金图或差异回归基准。',
      'Chrome/iPhone 真机兼容性由票据 15 验证，本目录只覆盖 Linux Chromium。',
      '图片内容为固定 SVG 夹具，不是来源业务图；字体回退按本机实际渲染记录。',
    ],
  });
});
