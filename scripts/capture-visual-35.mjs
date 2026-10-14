// Production build + production API; no HTTP interception, injected CSS or golden snapshots.
// pnpm build && uv run python -m scripts.visual_preview --frontend-dir dist
// node scripts/capture-visual-35.mjs
import { chromium } from '@playwright/test';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const baseURL = process.env.VISUAL_PREVIEW_URL ?? 'https://127.0.0.1:18443';
const directory = process.env.VISUAL_OUTPUT_DIR ?? '.scratch/backend-integration/evidence/visual-35-current';
const referenceDirectory = process.env.UI_REFERENCE_DIR ?? 'docs/assets/ui-reference/current-35';
// 当前截图中的96图片px头像对齐实测48CSS px；这不是来源DPR已知的声明。
const referenceScale = Number(process.env.UI_REFERENCE_SCALE ?? (process.env.UI_REFERENCE_DIR ? '1' : '0.5'));
if (!Number.isFinite(referenceScale) || referenceScale <= 0) throw new Error('UI_REFERENCE_SCALE must be positive');
const imageSize = path => {
  const [width, height] = execFileSync('magick', ['identify', '-format', '%w %h', path], { encoding: 'utf8' }).trim().split(' ').map(Number);
  return { width, height };
};
const listReference = join(referenceDirectory, 'dynamics-list.png');
const detailReference = join(referenceDirectory, 'dynamic-detail.png');
try {
  await Promise.all([access(listReference), access(detailReference)]);
} catch {
  throw new Error('needs-info：缺少用户原始参考图，请补充两张 PNG 或设置 UI_REFERENCE_DIR；不能用当前页面自建基线。');
}
const references = { list: imageSize(listReference), detail: imageSize(detailReference) };
await mkdir(directory, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 1, timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
const conditions = {
  browser: browser.version(), date: new Date().toISOString(), baseURL,
  dpr: 1, zoom: '100%', timezone: 'Asia/Shanghai', samples: [],
  fontFallbackProbe: execFileSync('fc-match', ['system-ui'], { encoding: 'utf8' }).trim(),
  referenceDirectory, referenceScale, references,
  source: 'Current user references; viewport/DPR/zoom unknown. Scale aligns the pictured avatar to the 48 CSS px source DOM measurement, not a DPR claim.',
  comparison: 'Unmasked side-by-side and absolute difference. Business content and excluded features differ; no whole-image pass threshold.',
};
try {
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, path] of [['list', '/'], ['scope', '/ups/720'], ['detail', '/dynamics/710001'], ['manage', '/manage']]) {
      await page.goto(baseURL + path);
      await page.getByRole('article').first().waitFor();
      if (name === 'detail') await page.getByRole('list', { name: '一级评论', exact: true }).getByRole('listitem').first().waitFor();
      if (name === 'manage') {
        const card = page.getByRole('article', { name: 'UP 710', exact: true });
        await card.getByRole('button', { name: '读取检查状态', exact: true }).click();
        await card.getByRole('region', { name: '动态 710997 检查状态', exact: true }).waitFor();
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].filter(image => image.loading !== 'lazy').map(image => image.decode().catch(() => {})));
      });
      const metrics = await page.evaluate(() => {
        const main = document.querySelector('main');
        const style = getComputedStyle(main);
        return { overflow: document.documentElement.scrollWidth > innerWidth, font: style.fontFamily,
          main: main.getBoundingClientRect().toJSON(), background: getComputedStyle(document.documentElement).backgroundColor };
      });
      if (metrics.overflow) throw new Error(`${name} at ${width}px has page overflow`);
      conditions.samples.push({ name, width, height: 900, ...metrics });
      await page.screenshot({ path: join(directory, `${name}-${width}.png`), fullPage: true });
      if (width === 1280 && (name === 'list' || name === 'detail')) {
        await page.evaluate(() => scrollTo(0, 0));
        const main = await page.getByRole('main').boundingBox();
        // 列表新图是双图卡，选择同类虚构卡而不拿纯文字首卡充当图片对照。
        if (name === 'list') {
          const cards = await page.getByRole('article').all();
          let selected;
          for (const card of cards) {
            if (await card.getByRole('button', { name: /^预览图片/ }).count() === 2) { selected = card; break; }
          }
          if (!selected) throw new Error('needs-info：受控列表没有双图卡，不能以纯文字卡代替当前参考');
          await selected.screenshot({ path: join(directory, `${name}-region.png`) });
          conditions.samples.push({ name: 'list-region', readingId: await selected.getAttribute('data-reading-id'),
            region: 'One complete two-image card; actual card height retained, not padded or synthesized.' });
          continue;
        }
        // 详情从作者开始保留正文及评论；返回入口另有完整截图，不混入来源区域。
        const surface = await page.getByRole('article').first().boundingBox();
        await page.screenshot({ path: join(directory, `${name}-region.png`), clip: {
          x: main.x, y: surface.y, width: main.width, height: Math.round(references[name].height * referenceScale),
        } });
      }
    }
  }
  // 等比归一后取两侧最大画布，仅补白；不能按实现较短卡高裁掉来源图片/底部图标。
  for (const [name, reference] of [['list', listReference], ['detail', detailReference]]) {
    const rendered = join(directory, `${name}-region.png`);
    const size = imageSize(rendered);
    const canvas = { width: Math.max(size.width, Math.round(references[name].width * referenceScale)),
      height: Math.max(size.height, Math.round(references[name].height * referenceScale)) };
    const extent = `${canvas.width}x${canvas.height}`;
    const normalization = ['(', reference, '-resize', `${referenceScale * 100}%`, '-background', 'white', '-gravity', 'northwest', '-extent', extent, ')'];
    const implementation = ['(', rendered, '-background', 'white', '-gravity', 'northwest', '-extent', extent, ')'];
    execFileSync('magick', [...normalization, ...implementation, '+append', join(directory, `${name}-side-by-side.png`)]);
    execFileSync('magick', [...normalization, ...implementation, '-compose', 'difference', '-composite', join(directory, `${name}-difference.png`)]);
    conditions.samples.push({ name: `${name}-comparison`, canvas, implementation: size, reference: references[name], scale: referenceScale,
      normalization: 'Proportional avatar-based scale; white right/bottom padding to fit both full regions. No source cropping, content or structural masking.' });
  }
  await writeFile(join(directory, 'conditions.json'), JSON.stringify(conditions, null, 2));
  console.log(`截图与未遮罩对照：${directory}`);
} finally {
  await browser.close();
}
