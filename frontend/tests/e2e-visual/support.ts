import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, type Page, type Route } from '@playwright/test';
import {
  IMAGE_ORIGIN, firstPage, identities, mainDynamicId, replies, rootComments, rootWithReplies, secondPage,
} from './fixtures';

/** 票据 14 的四个验收宽度与固定 CSS 视口高度；截图条件按此记录。 */
export const VIEWPORTS = [360, 390, 768, 1280] as const;
export const VIEWPORT_HEIGHT = 900;
export const SCREENSHOT_DIR = join(
  process.cwd(), '..', '.scratch', 'frontend-vue-migration', 'evidence', 'visual-14',
);

export interface ArchiveFaults {
  listEmpty?: boolean;
  listError?: boolean;
  unknownUp?: boolean;
  detailNotFound?: boolean;
  detailError?: boolean;
  commentsError?: boolean;
  repliesError?: boolean;
  repliesEmpty?: boolean;
  upsError?: boolean;
}

const error = (code: string, extra: Record<string, unknown> = {}) => ({ error: { code, ...extra } });

function replyPage(url: URL) {
  const page = Number(url.searchParams.get('page'));
  const limit = Number(url.searchParams.get('limit'));
  const root = rootComments.find(item => item.id === rootWithReplies)!;
  const start = (page - 1) * limit;
  return {
    items: replies.slice(start, start + limit),
    next_cursor: null,
    count: replies.length,
    root,
    source_reply_count: replies.length,
    local_reply_count: replies.length,
  };
}

function replyPreview(url: URL) {
  const limit = Number(url.searchParams.get('limit'));
  return {
    items: replies.slice(0, limit),
    next_cursor: replies.length > limit ? String(limit) : null,
    source_reply_count: replies.length,
    local_reply_count: replies.length,
  };
}

/**
 * 生产 Adapter 的 HTTP 替身：DTO 与图片都由本文件提供，页面仍走真实 Adapter 映射。
 * 每类失败都只影响对应请求，便于单独拍空态/错误态。
 */
export async function stubArchive(page: Page, faults: ArchiveFaults = {}): Promise<void> {
  await page.route('**/api/archive/**', async route => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body as Record<string, unknown> });

    if (url.pathname === '/api/archive/ups') {
      return faults.upsError ? json(error('UPSTREAM_UNAVAILABLE'), 503) : json({ ups: identities });
    }

    if (url.pathname === '/api/archive/dynamics') {
      if (faults.listError) return json(error('UPSTREAM_UNAVAILABLE', { message: 'SECRET_TOKEN' }), 503);
      if (faults.listEmpty) return json({ items: [], next_cursor: null });
      if (url.searchParams.get('scope') === 'up') {
        if (faults.unknownUp) return json(error('UNKNOWN_UP'), 404);
        const uid = url.searchParams.get('uid');
        const items = firstPage.filter(item => item.author.id === uid);
        return json({ items, next_cursor: null });
      }
      return url.searchParams.get('cursor') === null
        ? json({ items: firstPage, next_cursor: '10' })
        : json({ items: secondPage, next_cursor: null });
    }

    const detail = /^\/api\/archive\/dynamics\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      if (faults.detailNotFound) return json(error('NOT_FOUND'), 404);
      if (faults.detailError) return json(error('STORAGE_UNAVAILABLE'), 503);
      const found = [...firstPage, ...secondPage].find(item => item.id === detail[1]);
      return found ? json(found) : json(error('NOT_FOUND'), 404);
    }

    const comments = /^\/api\/archive\/dynamics\/([^/]+)\/comments$/.exec(url.pathname);
    if (comments) {
      if (faults.commentsError) return json(error('UPSTREAM_UNAVAILABLE'), 503);
      // 只有主动态带评论；其余动态按归档元数据表达“暂无评论/评论尚未归档”。
      if (comments[1] !== mainDynamicId) return json({ items: [], next_cursor: null });
      return url.searchParams.get('cursor') === null
        ? json({ items: rootComments.slice(0, 20), next_cursor: '20' })
        : json({ items: [], next_cursor: null });
    }

    const replyRoute = /^\/api\/archive\/dynamics\/([^/]+)\/comments\/([^/]+)\/replies$/.exec(url.pathname);
    if (replyRoute) {
      if (faults.repliesError) return json(error('UPSTREAM_UNAVAILABLE'), 503);
      if (faults.repliesEmpty || replyRoute[2] !== rootWithReplies) {
        const root = rootComments.find(item => item.id === replyRoute[2]);
        return url.searchParams.get('page') === null
          ? json({ items: [], next_cursor: null, source_reply_count: 0 })
          : json({ items: [], next_cursor: null, count: 0, root });
      }
      return url.searchParams.get('page') === null ? json(replyPreview(url)) : json(replyPage(url));
    }

    return json(error('NOT_FOUND'), 404);
  });
}

function fixtureSvg(path: string): string {
  const long = path.includes('long');
  const width = 1200;
  const height = long ? 6000 : 675;
  const label = path.split('/').pop() ?? 'image';
  const bands = ['#0f6b72', '#1b4f72', '#5b2c6f', '#145a32', '#7d6608'];
  const bandHeight = height / bands.length;
  const stripes = bands.map((color, index) => (
    `<rect x="0" y="${Math.round(index * bandHeight)}" width="${width}" height="${Math.ceil(bandHeight)}" fill="${color}"/>`
  )).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + stripes
    + `<text x="${width / 2}" y="${Math.round(height / 2)}" fill="#ffffff" font-family="sans-serif" `
    + `font-size="${long ? 96 : 64}" text-anchor="middle">${label}</text></svg>`;
}

/** 固定图片内容：同一路径每次都得到同一 SVG，不依赖外部网络。 */
export async function stubImages(page: Page): Promise<void> {
  await page.route(`${IMAGE_ORIGIN}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('broken')) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'fixture failure' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fixtureSvg(path) });
  });
}

/** 字体、已在视口内的图片与两个布局帧都稳定后再截图，避免拍在懒加载/动画中间。 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images]
      .filter(image => image.loading !== 'lazy')
      .map(image => image.decode().catch(() => undefined)));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.waitForTimeout(120);
}

export interface Sample {
  readonly name: string;
  readonly width: number;
  readonly url: string;
  readonly scrollY: number;
  readonly bytes: number;
  readonly sha256: string;
}

let samples: Sample[] = [];

export function resetSamples(): void {
  samples = [];
}

export function collectedSamples(): readonly Sample[] {
  return samples;
}

export async function capture(page: Page, name: string): Promise<void> {
  await settle(page);
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  const bytes = await readFile(path);
  samples.push({
    name,
    width: page.viewportSize()?.width ?? 0,
    url: page.url(),
    scrollY: await page.evaluate(() => Math.round(window.scrollY)),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}

export async function writeConditions(payload: Record<string, unknown>): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await writeFile(join(SCREENSHOT_DIR, 'conditions.json'), `${JSON.stringify(payload, null, 2)}\n`);
}

export async function prepareOutputDirectory(): Promise<void> {
  await rm(SCREENSHOT_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

/** 页面横溢、UP 条自身横滚与容器内容宽度的统一度量。 */
export async function layoutMetrics(page: Page) {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.up-strip');
    const overflowing = [...document.querySelectorAll<HTMLElement>('.dynamic-card, .comment, .manage-up')]
      .filter(node => node.scrollWidth > node.clientWidth + 1)
      .map(node => node.className);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      stripScrollWidth: strip?.scrollWidth ?? 0,
      stripClientWidth: strip?.clientWidth ?? 0,
      overflowing,
    };
  });
}

export interface TargetBox {
  readonly selector: string;
  readonly text: string;
  readonly width: number;
  readonly height: number;
}

/** 可见的主要触控区域；隐藏的原生 radio 由外层 label 承担点击，不计入。 */
export async function touchTargets(page: Page, selectors: readonly string[]): Promise<TargetBox[]> {
  return page.evaluate(names => {
    const boxes: TargetBox[] = [];
    for (const selector of names) {
      for (const node of document.querySelectorAll<HTMLElement>(selector)) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0) continue;
        boxes.push({
          selector,
          text: (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 30),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }
    return boxes;
  }, [...selectors]);
}

/** 用真实键盘 Tab 到达目标：程序化 focus 不一定触发 :focus-visible。 */
export async function tabTo(page: Page, selector: string, max = 200): Promise<boolean> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  for (let index = 0; index < max; index += 1) {
    await page.keyboard.press('Tab');
    const reached = await page.evaluate(name => {
      const node = document.querySelector(name);
      return Boolean(node && document.activeElement === node);
    }, selector);
    if (reached) return true;
  }
  return false;
}

/** 键盘焦点必须可见：只接受有实际宽度的 outline 或 box-shadow。 */
export async function focusStyle(page: Page, selector: string) {
  return page.evaluate(name => {
    const node = document.querySelector<HTMLElement>(name);
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      focused: document.activeElement === node,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      boxShadow: style.boxShadow,
    };
  }, selector);
}

export async function expectNoPageOverflow(page: Page, label: string): Promise<void> {
  const metrics = await layoutMetrics(page);
  expect(metrics.scrollWidth, `${label} 页面不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.overflowing, `${label} 卡片内容不应横向溢出`).toEqual([]);
}
