// 仅校验临时对照工具；不作产品、像素或正式设备验收。
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = import.meta.dirname;
const stamp = new Date().toISOString().replaceAll(':', '-');
await mkdir(join(root, 'checks'), { recursive: true });
const output = join(root, 'checks', stamp);
await mkdir(output); // 相同目录已存在时拒绝覆盖旧结果。
const url = 'https://192.168.8.20:18443/visual-assets/visual-check/index.html';
const report = { checkedAt: new Date().toISOString(), url, purpose: '临时对照工具校验，非产品／像素／正式设备验收', expectedImages: 24, cases: [], errors: [] };
const browser = await chromium.launch();
try {
  for (const width of [360, 1280]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const sample = { width, blocked: [], pageErrors: [], httpErrors: [] };
    report.cases.push(sample);
    try {
      await context.route('**/*', route => {
        const request = route.request();
        const target = new URL(request.url());
        if (target.origin === new URL(url).origin && request.method() === 'GET') return route.continue();
        sample.blocked.push({ path: target.pathname, method: request.method() });
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => sample.pageErrors.push(error.message));
      page.on('response', response => { if (response.status() >= 400) sample.httpErrors.push({ path: new URL(response.url()).pathname, status: response.status() }); });
      const response = await page.goto(url, { waitUntil: 'networkidle' });
      sample.status = response.status();
      expect(sample.status).toBe(200);
      await page.evaluate(async () => {
        document.querySelectorAll('details').forEach(element => { element.open = true; });
        await Promise.all([...document.images].map(image => image.decode()));
      });
      Object.assign(sample, await page.evaluate(() => ({
        images: [...document.images].map(image => ({ path: new URL(image.currentSrc).pathname, naturalWidth: image.naturalWidth, renderedWidth: image.getBoundingClientRect().width })),
        overflow: document.documentElement.scrollWidth > innerWidth,
        externalLinks: [...document.querySelectorAll('a')].filter(anchor => anchor.origin !== location.origin).map(anchor => anchor.href),
        frameCaveat: document.body.textContent.includes('不能直接用裁片左/上留白判定页面缩进'),
        roleCaveat: document.body.textContent.includes('角色不同'),
        differenceCaveat: document.body.textContent.includes('无配准／遮罩／阈值'),
      })));
      expect(sample.images).toHaveLength(report.expectedImages);
      expect(sample.images.filter(image => image.path.endsWith('-difference.png'))).toHaveLength(4);
      expect(sample.images.every(image => image.naturalWidth > 0 && image.naturalWidth === image.renderedWidth)).toBe(true);
      expect(sample.overflow).toBe(false);
      expect(sample.externalLinks).toEqual([]);
      expect(sample.blocked).toEqual([]);
      expect(sample.pageErrors).toEqual([]);
      expect(sample.httpErrors).toEqual([]);
      expect(sample.frameCaveat && sample.roleCaveat && sample.differenceCaveat).toBe(true);
    } finally {
      await context.close();
    }
  }
} catch (error) {
  report.errors.push(error.stack ?? error.message);
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'comparison-page-check.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, errors: report.errors, cases: report.cases.length }));
}
if (report.errors.length) process.exitCode = 1;
