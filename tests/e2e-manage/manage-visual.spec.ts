import { expect, test, type Locator, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// T1：仅替换 HTTP 响应，页面仍使用正常生产装配中的 ManagementApi。
// 管理无对应 B站截图：断言参考规则映射，输出受控截图，不自建像素基线。
const targetId = '9'.repeat(128);
const up = (uid: string, mode: 'recent' | 'specified' = 'recent') => ({
  uid, name: uid === '123' ? '虚构管理作者 🌸' : '很长的虚构昵称🌸'.repeat(12), avatar_url: null,
  monitor: { mode, recent_n: 10, enabled: true, last_checked_at: null, last_succeeded_at: null },
});
const parts = { text: 'success', media: 'success', comments: 'success', replies: 'success', comment_media: 'success' };
const baseCheck = {
  id: '1', active: true, check_status: 'checked', work: 'pending', revision: 1,
  last_checked_at: '2025-06-01T02:00:00Z', last_succeeded_at: null,
  observed: { observed_version: 'edit:2025-06-01T10:00+08:00', edit_status: 'observed' },
  synced_version: null, check_error: null, sync_error: null, parts,
};
const checks = [
  { ...baseCheck, id: '1', check_status: 'unchecked', revision: 0, observed: {}, last_checked_at: null,
    parts: { text: 'pending', media: 'pending', comments: 'pending', replies: 'pending', comment_media: 'pending' } },
  { ...baseCheck, id: '2', check_status: 'unchanged', sync_error: 'SYNC_INCOMPLETE',
    parts: { ...parts, text: 'restricted', media: 'failed' } },
  { ...baseCheck, id: '3', work: 'running' },
  { ...baseCheck, id: '4', active: false, check_status: 'failed', check_error: 'SIGNAL_INVALID',
    observed: { edit_status: 'error' }, parts: { ...parts, text: 'failed' } },
  { ...baseCheck, id: '5' }, // 分项已完成，但整轮待确认。
  { ...baseCheck, id: '6', work: 'complete', synced_version: baseCheck.observed.observed_version,
    last_succeeded_at: '2025-06-01T02:01:00Z' },
];

async function installHttp(page: Page) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  await page.route('**/api/manage/**', async route => {
    const request = route.request();
    const url = new URL(request.url()).pathname;
    const method = request.method();
    const body: unknown = request.postDataJSON();
    calls.push({ url, method, body });
    if (url.endsWith('/checks')) return route.fulfill({ json: { checks } });
    if (url.endsWith('/targets') && method === 'GET') return route.fulfill({ json: { targets: [{ id: targetId }] } });
    if (url.endsWith('/monitor') && method === 'PATCH') {
      const uid = url.split('/')[4]!;
      if (typeof body !== 'object' || body === null) throw new Error('Expected monitor JSON');
      return route.fulfill({ json: { ...up(uid), monitor: { ...up(uid).monitor, ...body } } });
    }
    if (url.endsWith('/targets') && method === 'POST') return route.fulfill({ status: 201, json: body });
    return route.fulfill({ json: { ups: [up('123'), up('456', 'specified'), { ...up('789'), name: null, monitor: null }] } });
  });
  return calls;
}

// “详细设置”默认折叠，关闭时内部控件不在无障碍树里；断言前先展开。
async function expandDetails(card: Locator) {
  await card.getByText('详细设置', { exact: true }).click();
}

for (const width of [360, 390, 768, 1280]) {
  test(`管理规则映射：${width}px 居中分区、触控与真实状态`, async ({ page }, testInfo) => {
    const calls = await installHttp(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/manage');
    const card = page.getByRole('article', { name: 'UP 123', exact: true });
    const specified = page.getByRole('article', { name: 'UP 456', exact: true });
    const deleted = page.getByRole('article', { name: 'UP 789', exact: true });
    for (const article of [card, specified, deleted]) await expandDetails(article);
    await expect(specified.getByRole('button', { name: `移除目标 ${targetId}` })).toBeVisible();
    // 初始加载没有隐式读取 checks，更没有同步或轮询。
    expect(calls.some(call => call.url.endsWith('/checks'))).toBe(false);
    await card.getByRole('button', { name: '读取检查状态', exact: true }).click();
    // 详情默认折叠：先确认折叠态，再逐条展开后校验细节行。
    await expect(card.getByRole('button', { name: '展开动态 1 详情', exact: true })).toHaveAttribute('aria-expanded', 'false');
    for (const id of [1, 2, 3, 4, 5, 6]) {
      await card.getByRole('button', { name: `展开动态 ${id} 详情`, exact: true }).click();
    }
    await expect(card.getByRole('region', { name: '动态 1 检查状态' })).toContainText('编辑信号未知；不代表确认未编辑。');
    await expect(card.getByRole('region', { name: '动态 2 检查状态' })).toContainText('检查无变化；不代表同步完成。');
    await expect(card.getByRole('region', { name: '动态 2 检查状态' })).toContainText('正文受限；动态图失败');
    await expect(card.getByRole('region', { name: '动态 3 检查状态' })).toContainText('同步中');
    await expect(card.getByRole('region', { name: '动态 4 检查状态' })).toContainText('检查失败');
    await expect(card.getByRole('region', { name: '动态 5 检查状态' })).toContainText('分项已完成，整轮待确认');
    await expect(card.getByRole('region', { name: '动态 6 检查状态' })).toContainText('实际整轮成功：2025-06-01 10:01:00');
    const deletedCard = page.getByRole('article', { name: 'UP 789', exact: true });
    await expect(deletedCard.getByRole('button', { name: '重新添加监控' })).toBeEnabled();
    await expect(deletedCard.getByRole('button', { name: '读取检查状态' })).toBeEnabled();

    const main = page.getByRole('main');
    const mainMeasurements = await main.evaluate(element => {
      const box = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll<HTMLElement>('button, input, select, a')];
      return {
        viewport: innerWidth, dpr: devicePixelRatio,
        overflow: document.documentElement.scrollWidth > innerWidth,
        mainWidth: box.width, center: box.x + box.width / 2,
        background: getComputedStyle(document.body).backgroundColor,
        fontSize: getComputedStyle(element).fontSize, lineHeight: getComputedStyle(element).lineHeight, fontFamily: getComputedStyle(element).fontFamily,
        minControlHeight: Math.min(...controls.map(control => control.getBoundingClientRect().height)),
      };
    });
    const cardMeasurements = await card.evaluate(element => ({
      cardBackground: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
    }));
    const sections = ['监控配置', '指定动态目标', '目标检查与归档状态'];
    const addBox = (await page.getByRole('form', { name: '添加 UP', exact: true }).boundingBox())!;
    const measurements = {
      ...mainMeasurements, ...cardMeasurements,
      authorColor: await card.getByRole('heading', { name: '虚构管理作者 🌸', exact: true }).evaluate(element => getComputedStyle(element).color),
      avatarWidth: (await card.getByRole('img', { name: '虚构管理作者 🌸的头像', exact: true }).boundingBox())!.width,
      headings: await card.getByRole('heading', { level: 2 }).allTextContents(),
      sectionBorders: await Promise.all(sections.map(name => card.getByRole('region', { name, exact: true }).evaluate(element => getComputedStyle(element).borderTopColor))),
      cardGap: (await card.boundingBox())!.y - addBox.height - addBox.y,
    };
    expect(measurements).toMatchObject({
      overflow: false, mainWidth: Math.min(716, width - 24), center: width / 2,
      background: 'rgb(209, 232, 231)', cardBackground: 'rgb(255, 255, 255)', radius: '4px',
      authorColor: 'rgb(251, 114, 153)', avatarWidth: 48, fontSize: '16px', lineHeight: '25px',
      headings: ['虚构管理作者 🌸', '监控配置', '指定动态目标', '近期发现与当前窗口', '目标检查与归档状态'], cardGap: 8,
    });
    expect(measurements.minControlHeight).toBeGreaterThanOrEqual(44);
    expect(measurements.sectionBorders.every(color => color === 'rgb(227, 229, 231)')).toBe(true);
    // 等待字体后保存截图；受控内容、原生 Chromium、100% 缩放，不冒称 Safari 真机签收。
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: testInfo.outputPath(`manage-${width}.png`), fullPage: true });
    const mappingPath = testInfo.outputPath('mapping.json');
    await writeFile(mappingPath, JSON.stringify({
      reference: 'docs/assets/ui-reference/*.png（来源 CSS 视口、DPR 与缩放未知）',
      comparison: '仅管理规则映射，未进行阅读图像素差异比较或人工视觉签收',
      browser: page.context().browser()?.version(), fontDeclaration: mainMeasurements.fontFamily, zoom: '100%', measurements,
    }, null, 2));
    await testInfo.attach('管理规则映射与渲染条件', { contentType: 'application/json', path: mappingPath });
    expect(calls.filter(call => call.url.endsWith('/checks'))).toHaveLength(1);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });
}

test('管理键盘顺序、清晰焦点、独立草稿及 Enter 提交仍经过 HTTP 边界', async ({ page }) => {
  const calls = await installHttp(page);
  await page.goto('/manage');
  const card = page.getByRole('article', { name: 'UP 123', exact: true });
  const specified = page.getByRole('article', { name: 'UP 456', exact: true });
  // “详细设置”折叠时 Tab 会经过摘要，展开后才进入配置字段。
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: '返回阅读' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'UP UID', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '添加监控', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card.getByRole('button', { name: '停止监控' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(card.getByText('详细设置', { exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('combobox', { name: '监控模式' })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(card.getByRole('combobox', { name: '监控模式' })).toBeFocused();
  await page.keyboard.press('Tab');
  const n = card.getByRole('textbox', { name: '近期 N 条', exact: true });
  await expect(n).toBeFocused();
  await n.fill('27');
  await page.keyboard.press('Tab');
  const save = card.getByRole('button', { name: '保存配置', exact: true });
  await expect(save).toBeFocused();
  expect(await save.evaluate(element => ({
    width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle,
  }))).toEqual({ width: '3px', style: 'solid' });
  await page.keyboard.press('Enter');
  await expect(card.getByText('保存成功。', { exact: true })).toBeVisible();
  await expect(n).toHaveValue('27');
  expect(calls.filter(call => call.method === 'PATCH')).toEqual([{
    url: '/api/manage/ups/123/monitor', method: 'PATCH', body: { mode: 'recent', recent_n: 27, enabled: true },
  }]);
  await expandDetails(specified);
  await expect(specified.getByRole('combobox', { name: '监控模式' })).toHaveValue('specified');
  const id = specified.getByRole('textbox', { name: '动态 ID', exact: true });
  await id.fill('22');
  await id.press('Tab');
  await expect(specified.getByRole('button', { name: '校验并添加目标' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(specified.getByText('归属校验通过，目标关联已保存。')).toBeVisible();
  expect(calls.filter(call => call.method === 'POST')).toEqual([{
    url: '/api/manage/ups/456/targets', method: 'POST', body: { id: '22' },
  }]);
  await expect(specified.getByRole('button', { name: '移除目标 22' })).toBeEnabled();
  await expect(n).toHaveValue('27');
});
