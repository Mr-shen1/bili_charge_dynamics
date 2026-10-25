// 票据 14：四宽度布局与可操作性审计。只断言，不生成黄金图；视觉签收由用户单独完成。
import { expect, test, type Page } from '@playwright/test';
import { mainDynamicId, rootWithReplies } from './fixtures';
import {
  VIEWPORT_HEIGHT, VIEWPORTS, expectNoPageOverflow, focusStyle, layoutMetrics, settle,
  stubArchive, stubImages, tabTo, touchTargets,
} from './support';

const touchSelectors = [
  '.app-brand', '.app-nav a', '.up-option', '.comment-entry', '.fold-toggle', '.image-grid__trigger',
];

const manageSelectors = [
  '.app-brand', '.app-nav a', '.manage-crumbs a', '.manage-submit', '.manage-up-link', '.manage-toggle',
  '.manage-read', '.manage-save', '.el-radio', '.el-input__wrapper', '.el-button',
];

async function expectTouchTargets(page: Page, selectors: readonly string[], label: string): Promise<void> {
  const boxes = await touchTargets(page, selectors);
  expect(boxes.length, `${label} 应至少有一个主要触控区域`).toBeGreaterThan(0);
  for (const box of boxes) {
    // 约 44px：允许 1px 的边框/取整误差，不接受 32px 级别的输入框或 24px 的链接。
    // 只约束高度；文字链接的宽度由文本长度决定，不强行撑到 44px。
    expect(box.height, `${label} ${box.selector}「${box.text}」触控高度`).toBeGreaterThanOrEqual(43);
  }
}

interface FocusStyle {
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly boxShadow: string;
}

function hasVisibleFocus(style: FocusStyle): boolean {
  return (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 1)
    || style.boxShadow !== 'none';
}

async function expectCrumbsOnOneLine(page: Page, label: string): Promise<void> {
  const layout = await page.evaluate(() => {
    const crumbs = document.querySelector<HTMLElement>('.manage-crumbs');
    const header = document.querySelector<HTMLElement>('.manage-header');
    const items = [...document.querySelectorAll<HTMLElement>('.manage-crumbs > *')];
    // 比较文字自身的矩形：只比容器 top 会把“文字在 44px 盒子里顶对齐”的错位漏掉。
    const textTops = items.map(node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().top;
    });
    return {
      itemCount: items.length,
      itemTops: items.map(node => Math.round(node.getBoundingClientRect().top)),
      textTops: textTops.map(top => Math.round(top * 10) / 10),
      headerHeight: Math.round(header?.getBoundingClientRect().height ?? 0),
      crumbsHeight: Math.round(crumbs?.getBoundingClientRect().height ?? 0),
    };
  });
  expect(layout.itemCount, `${label} 应至少有返回与当前页两个入口`).toBeGreaterThanOrEqual(2);
  expect(new Set(layout.itemTops).size, `${label} 面包屑应同处一行：${layout.itemTops}`).toBe(1);
  const textSpread = Math.max(...layout.textTops) - Math.min(...layout.textTops);
  expect(textSpread, `${label} 面包屑文字应在同一水平线：${layout.textTops}`).toBeLessThanOrEqual(1);
  // 页头保持一行：标题与 44px 面包屑不会叠成两行高度。
  expect(layout.headerHeight, `${label} 页头不应换成两行（高度 ${layout.headerHeight}）`).toBeLessThan(60);
  expect(layout.crumbsHeight, `${label} 面包屑高度`).toBeLessThanOrEqual(44);
}

async function expectKeyboardFocus(page: Page, selector: string, label: string): Promise<void> {
  const reached = await tabTo(page, selector);
  expect(reached, `${label} 键盘 Tab 应能到达 ${selector}`).toBe(true);
  const state = await focusStyle(page, selector);
  expect(state, `${label} 应存在可聚焦元素 ${selector}`).not.toBeNull();
  expect(hasVisibleFocus(state!), `${label} ${selector} 焦点样式不可见：${JSON.stringify(state)}`).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test('四宽度阅读布局、触控与焦点', async ({ page }) => {
  await stubImages(page);
  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });

    // 列表：页面不横溢、UP 条只自身横滚，长正文折叠且可展开。
    await page.unroute('**/api/archive/**');
    await stubArchive(page);
    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(10);
    await expectNoPageOverflow(page, `${width}px 列表`);
    const list = await layoutMetrics(page);
    expect(list.stripScrollWidth, `${width}px UP 条应在容器内横滚`).toBeGreaterThan(list.stripClientWidth);
    await expectTouchTargets(page, touchSelectors, `${width}px 列表`);

    const firstCard = page.getByRole('article').first();
    const collapsed = firstCard.locator('.text');
    expect(await collapsed.getAttribute('class')).toContain('collapsed');
    const collapsedBox = await collapsed.boundingBox();
    expect(collapsedBox!.height, `${width}px 列表 6 行折叠高度`).toBeGreaterThan(140);
    expect(collapsedBox!.height, `${width}px 列表 6 行折叠高度`).toBeLessThan(160);
    await firstCard.getByRole('button', { name: '展开正文' }).click();
    expect(await collapsed.getAttribute('class')).not.toContain('collapsed');
    expect((await collapsed.boundingBox())!.height, `${width}px 展开后应显示全文`).toBeGreaterThan(collapsedBox!.height);
    // 恰好 6 行的正文不出现折叠入口：折叠按实际行数判断，不是一刀切。
    await expect(page.getByRole('article').nth(4).locator('.fold-toggle')).toHaveCount(0);
    await expectKeyboardFocus(page, '.card-link', `${width}px 列表卡片`);
    await expectKeyboardFocus(page, '.up-option', `${width}px UP 选项`);

    // 图片组完整可达：首卡 4 张，预览可用键盘逐张切换。
    await expect(firstCard.locator('.image-grid__trigger')).toHaveCount(4);
    await firstCard.locator('.image-grid__trigger').first().click();
    await expect(page.locator('.preview-counter')).toHaveText('1 / 4');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.preview-counter')).toHaveText('2 / 4');
    await page.keyboard.press('Escape');
    await expect(page.locator('.el-image-viewer__wrapper')).toHaveCount(0);
    await expectKeyboardFocus(page, '.image-grid__trigger', `${width}px 图片缩略图`);

    // 单 UP scope：选中态与卡片数量。
    await page.goto('/ups/1002');
    await expect(page.getByRole('article')).toHaveCount(2);
    await expectNoPageOverflow(page, `${width}px 单 UP 列表`);
    await expect(page.getByRole('link', { name: /夜航岛/ })).toHaveAttribute('aria-current', 'page');

    // 详情：正文全文展示，评论仍按 6 行折叠。
    await page.goto(`/dynamics/${mainDynamicId}`);
    await expect(page.locator('.detail-card')).toBeVisible();
    await expectNoPageOverflow(page, `${width}px 详情`);
    await expect(page.locator('.detail-card .fold-toggle')).toHaveCount(0);
    expect(await page.locator('.detail-card .text').getAttribute('class')).not.toContain('collapsed');
    await expect(page.locator('.comment-entry')).toHaveCount(0);

    await page.locator('.comment-section').evaluate(node =>
      node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await page.waitForTimeout(200);
    await settle(page);
    await expectNoPageOverflow(page, `${width}px 一级评论`);
    const firstComment = page.getByRole('list', { name: '一级评论' }).getByRole('listitem').first();
    expect(await firstComment.locator('.comment__body > .text').getAttribute('class')).toContain('collapsed');
    await expect(firstComment.getByRole('button', { name: '展开评论' })).toBeVisible();
    await expect(page.getByRole('list', { name: '一级评论' }).getByRole('listitem').nth(1)
      .locator('.comment__body > .fold-toggle')).toHaveCount(0);
    await expectTouchTargets(page, ['.comment-tab', '.comment-sort .el-radio-button', '.fold-toggle'],
      `${width}px 评论排序与折叠`);
    expect(await tabTo(page, '.comment-sort input'), `${width}px 评论排序应可用键盘到达`).toBe(true);
    const radioFocus = await page.evaluate(() => {
      const inner = document.querySelector<HTMLElement>('.comment-sort input + .el-radio-button__inner');
      if (!inner) return null;
      const style = getComputedStyle(inner);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
    });
    expect(radioFocus, `${width}px 评论排序应存在可见分段按钮`).not.toBeNull();
    expect(hasVisibleFocus(radioFocus!), `${width}px 评论排序焦点应可见：${JSON.stringify(radioFocus)}`).toBe(true);

    // 窄屏独立楼中楼：根评论全文直出，回复按 10 条/页。
    await page.goto(`/dynamics/${mainDynamicId}/comments/${rootWithReplies}`);
    await expect(page.getByRole('heading', { name: /相关回复共25条/ })).toBeVisible();
    await expectNoPageOverflow(page, `${width}px 楼中楼`);
    const rootText = page.locator('.thread-root__text');
    const clamped = await rootText.evaluate(node => node.scrollHeight > node.clientHeight + 1);
    expect(clamped, `${width}px 楼中楼根评论不应被裁剪`).toBe(false);
    await expect(page.getByRole('list', { name: '相关回复' }).getByRole('listitem')).toHaveCount(10);
    await expectTouchTargets(page, ['.thread-back', '.reply-pager button'], `${width}px 楼中楼`);
  }
});

test('四宽度管理页布局、触控与焦点', async ({ page, request }) => {
  // 幂等准备：已有 202 时直接复用，保证本文件可单独运行。
  const created = await request.post('/api/manage/ups', { data: { uid: '202' } });
  expect([201, 409]).toContain(created.status());
  const patched = await request.patch('/api/manage/ups/202/monitor', {
    data: { mode: 'recent', recent_n: 10, enabled: true },
  });
  expect(patched.status()).toBe(200);

  for (const width of VIEWPORTS) {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await page.goto('/manage');
    await expect(page.getByRole('list', { name: 'UP 列表' })).toBeVisible();
    await expectNoPageOverflow(page, `${width}px 管理列表`);
    await expectTouchTargets(page, manageSelectors, `${width}px 管理列表`);
    await expectCrumbsOnOneLine(page, `${width}px 管理列表`);
    await expectKeyboardFocus(page, '.manage-up-link', `${width}px 管理列表`);

    await page.goto('/manage/ups/202');
    await expect(page.getByRole('article', { name: 'UP 202' })).toBeVisible();
    await expectNoPageOverflow(page, `${width}px 单 UP 管理`);
    await expectTouchTargets(page, manageSelectors, `${width}px 单 UP 管理`);
    await expectCrumbsOnOneLine(page, `${width}px 单 UP 管理`);
    // 最近 N 与保存按钮同属主要操作，桌面与手机都要可点按且不撑高卡片。
    const fieldHeights = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.manage-fields .el-form-item')]
        .map(node => Math.round(node.getBoundingClientRect().height)));
    expect(fieldHeights.length).toBeGreaterThan(0);
    for (const height of fieldHeights) {
      expect(height, `${width}px 监控配置项高度`).toBeLessThan(120);
    }

    // 指定模式：目标输入与移除按钮同样不横溢、不小于 44px。
    await page.getByText('指定动态 ID', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: '动态 ID' })).toBeVisible();
    await expectNoPageOverflow(page, `${width}px 指定模式`);
    await expectTouchTargets(page, ['.manage-target-submit', '.el-radio', '.el-input__wrapper'],
      `${width}px 指定模式`);
    await expectKeyboardFocus(page, '.manage-save', `${width}px 监控配置保存`);
  }
});
