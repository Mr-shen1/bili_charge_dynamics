// 票据 14：四宽度布局与可操作性审计。只断言，不生成黄金图；视觉签收由用户单独完成。
import { expect, test, type Page } from '@playwright/test';
import { mainDynamicId, rootWithReplies } from './fixtures';
import {
  VIEWPORT_HEIGHT, VIEWPORTS, expectNoPageOverflow, focusStyle, layoutMetrics, settle,
  stubArchive, stubImages, tabTo, touchTargets,
} from './support';

const touchSelectors = [
  '.up-option', '.comment-entry', '.fold-toggle', '.image-grid__trigger',
];

const manageSelectors = [
  '.manage-crumbs a', '.manage-submit', '.manage-up-link', '.manage-toggle',
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

/**
 * 票 12：轮廓是否被裁剪。把外扩矩形（outline 宽度 + offset）与所有裁剪祖先的 padding box 求交，
 * 四边裁切值都为 0 才算完整可见。元素本身没有 outline 时按传入的外扩量计算，
 * 用来检查横滑容器在末端是否为键盘焦点轮廓预留了空间。
 */
async function outlineClip(page: Page, selector: string, fallbackGrow = 5) {
  return page.evaluate(({ name, fallback }) => {
    const node = document.querySelector<HTMLElement>(name);
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const width = Number.parseFloat(style.outlineWidth) || 0;
    const offset = Number.parseFloat(style.outlineOffset) || 0;
    const grow = width + offset > 0 ? width + offset : fallback;
    const ring = {
      left: rect.left - grow, top: rect.top - grow, right: rect.right + grow, bottom: rect.bottom + grow,
    };
    const clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    const clippedBy: string[] = [];
    for (let parent = node.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.overflowX === 'visible' && parentStyle.overflowY === 'visible') continue;
      const parentRect = parent.getBoundingClientRect();
      const left = parentRect.left + (Number.parseFloat(parentStyle.borderLeftWidth) || 0);
      const top = parentRect.top + (Number.parseFloat(parentStyle.borderTopWidth) || 0);
      clip.left = Math.max(clip.left, left);
      clip.top = Math.max(clip.top, top);
      clip.right = Math.min(clip.right, left + parent.clientWidth);
      clip.bottom = Math.min(clip.bottom, top + parent.clientHeight);
      clippedBy.push(parent.className || parent.tagName);
    }
    const round = (value: number) => Math.round(value * 10) / 10;
    return {
      clippedBy,
      cut: {
        left: round(Math.max(0, clip.left - ring.left)),
        top: round(Math.max(0, clip.top - ring.top)),
        right: round(Math.max(0, ring.right - clip.right)),
        bottom: round(Math.max(0, ring.bottom - clip.bottom)),
      },
    };
  }, { name: selector, fallback: fallbackGrow });
}

async function expectOutlineComplete(
  page: Page, selector: string, label: string, fallbackGrow = 5,
): Promise<void> {
  const clip = await outlineClip(page, selector, fallbackGrow);
  expect(clip, `${label} 应能定位轮廓元素 ${selector}`).not.toBeNull();
  const cut = clip!.cut;
  expect(Math.max(cut.left, cut.top, cut.right, cut.bottom),
    `${label} 轮廓被 ${clip!.clippedBy.join(' > ')} 裁切：${JSON.stringify(cut)}`).toBeLessThanOrEqual(0.5);
}

/**
 * 票 12：管理表单行的可见外框与文字基线。按钮与输入都按“44px 命中盒 + 内部可见块”表达，
 * 因此可见高度 = 盒高减掉 `::before` 的上下内缩；命中盒单独量。标签与控件中心用文字矩形比较，
 * 只比容器 top 会把“文字在 44px 盒子里顶对齐”的错位漏掉。
 */
async function formFrames(page: Page, scope: string) {
  return page.evaluate(selector => {
    const root = document.querySelector<HTMLElement>(selector);
    if (!root) return null;
    const frame = (node: HTMLElement) => {
      const before = getComputedStyle(node, '::before');
      const rect = node.getBoundingClientRect();
      const inset = before.content === 'none'
        ? 0
        : (Number.parseFloat(before.top) || 0) + (Number.parseFloat(before.bottom) || 0);
      return {
        visible: Math.round(rect.height - inset),
        hit: Math.round(rect.height),
        border: before.content === 'none' ? null : before.borderTopColor,
        background: before.content === 'none' ? getComputedStyle(node).backgroundColor : before.backgroundColor,
      };
    };
    const textCenter = (node: Element) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      return Math.round(((rect.top + rect.bottom) / 2) * 10) / 10;
    };
    const items = [...root.querySelectorAll<HTMLElement>('.el-form-item')].map(item => {
      const label = item.querySelector<HTMLElement>('.el-form-item__label');
      const content = item.querySelector<HTMLElement>('.el-form-item__content');
      const contentRect = content?.getBoundingClientRect();
      const input = item.querySelector<HTMLElement>('.el-input__wrapper');
      const inner = item.querySelector<HTMLElement>('.el-input__inner');
      return {
        label: (label?.textContent ?? '').trim(),
        labelCenter: label ? textCenter(label) : null,
        contentCenter: contentRect ? Math.round(((contentRect.top + contentRect.bottom) / 2) * 10) / 10 : null,
        radioCenters: [...item.querySelectorAll<HTMLElement>('.el-radio__label')].map(textCenter),
        inputTextCenter: inner ? Math.round(((inner.getBoundingClientRect().top + inner.getBoundingClientRect().bottom) / 2) * 10) / 10 : null,
        input: input ? frame(input) : null,
      };
    });
    const button = root.querySelector<HTMLElement>('.el-button');
    return {
      items,
      direction: getComputedStyle(root).flexDirection,
      button: button ? { ...frame(button), textCenter: textCenter(button) } : null,
    };
  }, scope);
}

/** 标签文字与同行控件中心对齐；桌面临界行再要求同排所有文字中心一致。 */
async function expectFormAlignment(page: Page, scope: string, width: number, label: string): Promise<void> {
  const frames = await formFrames(page, scope);
  expect(frames, `${label} 应存在表单 ${scope}`).not.toBeNull();
  expect(frames!.items.length, `${label} 应至少有一个表单项`).toBeGreaterThan(0);
  for (const item of frames!.items) {
    expect(Math.abs(item.labelCenter! - item.contentCenter!),
      `${label}「${item.label}」标签文字应落在同行控件中心：${item.labelCenter} vs ${item.contentCenter}`)
      .toBeLessThanOrEqual(1);
  }
  if (frames!.direction === 'row') {
    const centers = [
      ...frames!.items.map(item => item.labelCenter!),
      ...frames!.items.flatMap(item => item.radioCenters),
      ...frames!.items.filter(item => item.inputTextCenter !== null).map(item => item.inputTextCenter!),
      frames!.button!.textCenter,
    ];
    expect(Math.max(...centers) - Math.min(...centers),
      `${label} 同排标签/单选/输入/按钮文字应在同一水平线：${JSON.stringify(centers)}`)
      .toBeLessThanOrEqual(1);
  }
  const input = frames!.items.find(item => item.input)?.input;
  expect(input, `${label} 应存在输入框`).toBeTruthy();
  expect(input!.visible, `${label} 输入可见外框高度`).toBe(width <= 640 ? 36 : 32);
  expect(Math.abs(input!.visible - frames!.button!.visible),
    `${label} 输入与相邻按钮可见外框等高：${input!.visible} vs ${frames!.button!.visible}`)
    .toBeLessThanOrEqual(1);
  // 可见外框变小不牺牲命中盒：输入与按钮仍是 44px 可点按/可聚焦区域。
  expect(input!.hit, `${label} 输入命中盒高度`).toBeGreaterThanOrEqual(43);
  expect(frames!.button!.hit, `${label} 按钮命中盒高度`).toBeGreaterThanOrEqual(43);
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

/**
 * 管理页的计算尺寸：按钮视觉高度、真实点击高度、右边缘对齐、输入与按钮字号。
 * 视觉块由 `::before` 的上下 inset 画出，因此“看见的大小”与“点击区大小”要分开量。
 */
async function manageMetrics(page: Page) {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.manage-up');
    const button = document.querySelector<HTMLElement>('.manage-toggle');
    if (!card || !button) return null;
    const cardStyle = getComputedStyle(card);
    const cardRect = card.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const visual = getComputedStyle(button, '::before');
    const inset = visual.content === 'none'
      ? 0
      : (Number.parseFloat(visual.top) || 0) + (Number.parseFloat(visual.bottom) || 0);
    const input = [...document.querySelectorAll<HTMLInputElement>('.manage-up .el-input__inner, .manage-add .el-input__inner')]
      .find(node => node.getBoundingClientRect().width > 0);
    const hit = document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + 2);
    return {
      actionFont: Math.round(Number.parseFloat(getComputedStyle(button).fontSize)),
      actionHitHeight: Math.round(buttonRect.height),
      actionVisualHeight: Math.round(buttonRect.height - inset),
      actionWidth: Math.round(buttonRect.width),
      actionRightGap: Math.round(
        (cardRect.right - Number.parseFloat(cardStyle.borderRightWidth) - Number.parseFloat(cardStyle.paddingRight))
        - buttonRect.right,
      ),
      inputFont: input ? Math.round(Number.parseFloat(getComputedStyle(input).fontSize)) : 0,
      hitAtVisualEdge: hit === button || button.contains(hit),
    };
  });
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
    // 票 12：选中轮廓（2px + offset 2px）画在头像外，横滑容器不能把它裁在左/上。
    await expectOutlineComplete(page, '.up-option.selected .up-option__avatar, .up-option.selected .up-option__all',
      `${width}px 列表选中轮廓`);

    const firstCard = page.getByRole('article').first();
    const collapsed = firstCard.locator('.text');
    expect(await collapsed.getAttribute('class')).toContain('collapsed');
    const collapsedBox = await collapsed.boundingBox();
    // 新标尺正文 16/28：六行折叠高度为 6×28＝168px（票据 01 按实际行高重新验证）。
    expect(collapsedBox!.height, `${width}px 列表 6 行折叠高度`).toBeGreaterThan(160);
    expect(collapsedBox!.height, `${width}px 列表 6 行折叠高度`).toBeLessThan(176);
    await firstCard.getByRole('button', { name: '展开正文' }).click();
    expect(await collapsed.getAttribute('class')).not.toContain('collapsed');
    expect((await collapsed.boundingBox())!.height, `${width}px 展开后应显示全文`).toBeGreaterThan(collapsedBox!.height);
    // 恰好 6 行的正文不出现折叠入口：折叠按实际行数判断，不是一刀切。
    await expect(page.getByRole('article').nth(4).locator('.fold-toggle')).toHaveCount(0);
    await expectKeyboardFocus(page, '.card-link', `${width}px 列表卡片`);
    await expectKeyboardFocus(page, '.up-option', `${width}px UP 选项`);
    // 票 12：键盘焦点轮廓 3px + offset 2px 同样要完整；横滑到末端时最后一项也要有这 5px 空间。
    await expectOutlineComplete(page, '.up-option:focus-visible', `${width}px UP 选项键盘焦点轮廓`);
    await page.locator('.up-strip').evaluate(node => { node.scrollLeft = node.scrollWidth; });
    await page.waitForTimeout(150);
    await expectOutlineComplete(page, '.up-strip > li:last-child .up-option__avatar', `${width}px UP 条末端轮廓空间`);

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
    // 02 起排序是单个切换按钮（显示当前排序），点击区与视觉高度都由 44px 的按钮盒承担。
    await expectTouchTargets(page, ['.comment-tab', '.comment-sort', '.fold-toggle'],
      `${width}px 评论排序与折叠`);
    expect(await tabTo(page, '.comment-sort'), `${width}px 评论排序应可用键盘到达`).toBe(true);
    const sortFocus = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>('.comment-sort');
      if (!button) return null;
      const style = getComputedStyle(button);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow };
    });
    expect(sortFocus, `${width}px 评论排序应存在单按钮控件`).not.toBeNull();
    expect(hasVisibleFocus(sortFocus!), `${width}px 评论排序焦点应可见：${JSON.stringify(sortFocus)}`).toBe(true);

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
    const listInputFont = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.manage-add .el-input__inner');
      return input ? Math.round(Number.parseFloat(getComputedStyle(input).fontSize)) : 0;
    });
    expect(listInputFont, `${width}px 新增 UID 输入字号`).toBe(width <= 640 ? 16 : 14);
    // 票 12：标签与控件同排居中，输入可见外框与按钮等高（桌面 32 / 手机 36），命中盒仍 44。
    await expectFormAlignment(page, '.manage-add', width, `${width}px 新增 UP`);

    await page.goto('/manage/ups/202');
    await expect(page.getByRole('article', { name: 'UP 202' })).toBeVisible();
    await expectNoPageOverflow(page, `${width}px 单 UP 管理`);
    await expectTouchTargets(page, manageSelectors, `${width}px 单 UP 管理`);
    await expectCrumbsOnOneLine(page, `${width}px 单 UP 管理`);
    // 票据 08：状态在左、操作在右；按钮文字 13px，视觉 32/36px、点击区 44px，输入手机 16/桌面 14。
    const manage = await manageMetrics(page);
    expect(manage, `${width}px 单 UP 管理尺寸`).not.toBeNull();
    expect(manage!.actionFont, `${width}px 管理按钮文字字号`).toBe(13);
    expect(manage!.actionVisualHeight, `${width}px 管理按钮视觉高度`).toBe(width <= 640 ? 36 : 32);
    expect(manage!.actionHitHeight, `${width}px 管理按钮点击区高度`).toBeGreaterThanOrEqual(43);
    expect(manage!.actionWidth, `${width}px 四字按钮宽度`).toBeGreaterThanOrEqual(72);
    expect(manage!.actionWidth, `${width}px 四字按钮宽度`).toBeLessThanOrEqual(84);
    expect(Math.abs(manage!.actionRightGap), `${width}px 操作按钮右边缘对齐`).toBeLessThanOrEqual(1);
    expect(manage!.hitAtVisualEdge, `${width}px 视觉块外仍命中同一按钮`).toBe(true);
    expect(manage!.inputFont, `${width}px 管理输入字号`).toBe(width <= 640 ? 16 : 14);
    // 最近 N 与保存按钮同属主要操作，桌面与手机都要可点按且不撑高卡片。
    const fieldHeights = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.manage-fields .el-form-item')]
        .map(node => Math.round(node.getBoundingClientRect().height)));
    expect(fieldHeights.length).toBeGreaterThan(0);
    for (const height of fieldHeights) {
      expect(height, `${width}px 监控配置项高度`).toBeLessThan(120);
    }
    // 票 12：近期 N 行的标签、单选与输入同排居中，输入可见外框与保存按钮等高。
    await expectFormAlignment(page, 'section[aria-label="监控配置"] .manage-fields', width,
      `${width}px 监控配置`);

    // 指定模式：目标输入与移除按钮同样不横溢、不小于 44px。
    await page.getByText('指定动态 ID', { exact: true }).click();
    await expect(page.getByRole('textbox', { name: '动态 ID' })).toBeVisible();
    await expectNoPageOverflow(page, `${width}px 指定模式`);
    await expectTouchTargets(page, ['.manage-target-submit', '.el-radio', '.el-input__wrapper'],
      `${width}px 指定模式`);
    await expectFormAlignment(page, '.manage-target-add .manage-fields', width, `${width}px 添加指定目标`);
    await expectKeyboardFocus(page, '.manage-save', `${width}px 监控配置保存`);
  }
});

/**
 * 票 12：641–736px 时主栏会贴住视口两边，UP 条给轮廓预留的空间也必须在视口内。
 * 只取中间一个宽度做回归：这一段的验收宽度已由上面的四宽度矩阵覆盖。
 */
test('贴边宽度（700px）的选中轮廓完整且不新增横向溢出', async ({ page }) => {
  await stubImages(page);
  await stubArchive(page);
  await page.setViewportSize({ width: 700, height: VIEWPORT_HEIGHT });
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(10);
  await expectNoPageOverflow(page, '700px 列表');
  await expectOutlineComplete(page, '.up-option.selected .up-option__avatar, .up-option.selected .up-option__all',
    '700px 列表选中轮廓');
});

/**
 * 票 12：管理输入框的可见外框在悬停、聚焦与禁用时都要跟着状态变。
 * 库把边框与状态色写在 `.el-input__wrapper` 的 inset box-shadow 上；这里的断言不关心实现，
 * 只看“可见那块”的框色/底色：有 `::before` 看它，没有 `::before` 时退回 wrapper 自身的底色。
 * 禁用态用一次不落库的 409 替身把表单留在提交中，不向隔离 API 写入任何数据。
 */
test('管理输入框：悬停、聚焦与禁用态的可见外框都有状态变化', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: VIEWPORT_HEIGHT });
  await page.goto('/manage');
  await expect(page.locator('.manage-add .el-input__inner')).toBeVisible();

  const frame = async () => page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>('.manage-add .el-input__wrapper')!;
    const before = getComputedStyle(wrapper, '::before');
    const own = getComputedStyle(wrapper);
    // 没有 ::before 的可见块时，库用 inset box-shadow 表达边框色，用它作为替代信号。
    return {
      border: before.content === 'none' ? own.boxShadow : before.borderTopColor,
      background: before.content === 'none' ? own.backgroundColor : before.backgroundColor,
      disabled: wrapper.closest('.el-input')?.classList.contains('is-disabled') === true,
    };
  });

  const idle = await frame();
  await page.hover('.manage-add .el-input__inner');
  // 库的边框走 box-shadow 过渡（0.2s），等它稳定再量颜色。
  await page.waitForTimeout(300);
  const hovered = await frame();
  expect(hovered.border, `悬停时可见外框应换色：${JSON.stringify({ idle: idle.border, hovered: hovered.border })}`)
    .not.toBe(idle.border);

  await page.locator('.manage-add .el-input__inner').click();
  await page.waitForTimeout(300);
  const focused = await frame();
  expect(focused.border, `聚焦时可见外框应换成品牌色：${focused.border}`).toContain('rgb(18, 163, 174)');

  // 提交中把输入与按钮一起置为禁用：可见外框要跟着变灰，并且不落库。
  await page.route('**/api/manage/ups', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ status: 409, json: { error: { code: 'ALREADY_MONITORED' } } });
  });
  await page.getByRole('textbox', { name: 'UP UID' }).fill('202');
  await page.getByRole('button', { name: '添加监控' }).click();
  await expect.poll(async () => (await frame()).disabled, { message: '提交中输入框应进入禁用态' })
    .toBe(true);
  const disabled = await frame();
  expect(disabled.background,
    `禁用态可见外框底色应与可编辑态不同：${JSON.stringify({ idle: idle.background, disabled: disabled.background })}`)
    .not.toBe(idle.background);
  expect(disabled.border, `禁用态可见外框框色应与可编辑态不同：${disabled.border}`).not.toBe(idle.border);
  await expect(page.getByText('该 UID 已有监控配置。')).toBeVisible();
  await page.unroute('**/api/manage/ups');
});
