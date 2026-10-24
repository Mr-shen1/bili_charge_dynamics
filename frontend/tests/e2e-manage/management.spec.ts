import { expect, test, type Page } from '@playwright/test';

// 实际 API（backend/tests/live_app 的虚构上游资料）+ 本次运行独占的 SQLite。
// 页面仍由生产装配构建，请求经 vite 的 /api 代理到该进程；不访问真实上游。
const largeUid = '900719925474099312345';

function upCard(page: Page, uid: string) {
  return page.getByRole('article', { name: `UP ${uid}`, exact: true });
}

// 同一隔离 SQLite 由整个文件共享，按顺序执行让"先新增再操作"的依赖显式可见。
test.describe.configure({ mode: 'serial' });

test.describe('管理页与实际 API', () => {
  test('新增 UP 只提交 UID，资料由后端取得并持久化到隔离 SQLite', async ({ page }) => {
    await page.goto('/manage');
    await expect(page.getByText('尚未保存 UP，请输入 UID 添加。')).toBeVisible();

    const input = page.getByRole('textbox', { name: 'UP UID' });
    await input.fill(largeUid);
    await input.press('Enter');
    const link = page.getByRole('link', { name: `管理 UP ${largeUid}`, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toContainText('虚构星海');
    // 新增拿到后端默认配置：近期 10、停止监控。
    await expect(link).toContainText('监控已停止');
    await expect(page.getByText('添加成功。')).toBeVisible();

    await page.reload();
    await expect(link).toContainText('虚构星海');
    await expect(link).toContainText('监控已停止');
  });

  test('启停经实际 API 保存，刷新后仍是最后保存的状态', async ({ page }) => {
    await page.goto('/manage');
    const uidInput = page.getByRole('textbox', { name: 'UP UID' });
    await uidInput.fill('202');
    await uidInput.press('Enter');
    await expect(page.getByRole('link', { name: '管理 UP 202', exact: true })).toBeVisible();

    await page.goto('/manage/ups/202');
    const card = upCard(page, '202');
    await expect(card).toContainText('虚构晨光');
    await expect(card).toContainText('监控：已停止');

    await page.getByRole('button', { name: '启用监控', exact: true }).click();
    await expect(card).toContainText('监控：已启用');
    await expect(card).toContainText('启停已保存。');

    await page.reload();
    await expect(card).toContainText('监控：已启用');
    await page.getByRole('button', { name: '停止监控', exact: true }).click();
    await expect(card).toContainText('监控：已停止');
    await page.reload();
    await expect(card).toContainText('监控：已停止');
  });

  test('重复添加同一 UID 显示后端固定提示并保留输入', async ({ page }) => {
    await page.goto('/manage');
    const input = page.getByRole('textbox', { name: 'UP UID' });
    await input.fill('202');
    await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('该 UID 已有监控配置');
    await expect(input).toHaveValue('202');
    await expect(page.getByText('添加成功。')).toHaveCount(0);
  });

  test('上游资料不可用时保留输入且不回显服务端诊断', async ({ page }) => {
    await page.goto('/manage');
    const input = page.getByRole('textbox', { name: 'UP UID' });
    await input.fill('303');
    await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('未取得 UP 资料');
    await expect(page.locator('body')).not.toContainText('FICTIONAL_SECRET_LIVE_PROFILE');
    await expect(input).toHaveValue('303');
    // 失败不产生身份：列表里没有 303 的卡片。
    await expect(page.getByRole('link', { name: '管理 UP 303', exact: true })).toHaveCount(0);
  });

  test('未知 UP 地址可直达并回到列表', async ({ page }) => {
    await page.goto('/manage/ups/404404');
    await expect(page.getByText('未找到该 UP，可能已被删除。')).toBeVisible();
    await page.getByRole('link', { name: '返回 UP 列表', exact: true }).click();
    await expect(page.getByRole('list', { name: 'UP 列表' })).toBeVisible();
  });
});

test('指定模式目标校验、停用/移除/删除配置后归档与阅读入口都保留', async ({ page }) => {
  // 新增 UP 后保存互斥模式并启用监控：指定模式的入选集合来自关联目标。
  await page.goto('/manage');
  const uidInput = page.getByRole('textbox', { name: 'UP UID' });
  await uidInput.fill('707');
  await uidInput.press('Enter');
  await expect(page.getByRole('link', { name: '管理 UP 707', exact: true })).toBeVisible();

  await page.goto('/manage/ups/707');
  const card = upCard(page, '707');
  await expect(card).toContainText('虚构晚风');
  // 默认近期 10：表单直接反映已保存配置。
  await expect(card.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');

  // Element Plus 隐藏原生 radio，点击可见标签才是真实用户路径。
  await card.getByText('指定动态 ID', { exact: true }).click();
  await expect(card.getByRole('textbox', { name: '近期 N 条' })).toHaveCount(0);
  await card.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(card).toContainText('已保存模式：指定动态 ID。');
  await expect(card).toContainText('保存成功。');
  await card.getByRole('button', { name: '启用监控', exact: true }).click();
  await expect(card).toContainText('监控：已启用');

  const targetInput = card.getByRole('textbox', { name: '动态 ID' });
  await expect(card).toContainText('尚未添加指定目标。');

  // 作者不符与无法确认是两种结果，都保留输入且不建立关联。
  await targetInput.fill('800100');
  await targetInput.press('Enter');
  await expect(card.getByRole('alert').filter({ hasText: '动态作者与所选 UP 不符' })).toBeVisible();
  await expect(targetInput).toHaveValue('800100');
  await targetInput.fill('800200');
  await targetInput.press('Enter');
  await expect(card.getByRole('alert').filter({ hasText: '无法确认动态归属' })).toBeVisible();
  await expect(targetInput).toHaveValue('800200');

  await targetInput.fill('900707');
  await targetInput.press('Enter');
  await expect(card).toContainText('归属校验通过，目标关联已保存。');
  await expect(card.getByRole('list', { name: '指定动态目标列表' })).toContainText('900707');
  await expect(targetInput).toHaveValue('');

  // 显式初始化仍由执行者触发；这里只走页面同源 HTTP，上游由虚构 fixture 提供。
  const sync = await page.request.post('/api/sync/initial', { data: { uid: '707' } });
  expect(sync.status()).toBe(200);
  expect(await sync.json()).toEqual({ processed: 1, succeeded: 1, failed: 0 });
  const archivedText = async () => {
    const response = await page.request.get('/api/archive/dynamics/900707');
    expect(response.status()).toBe(200);
    return (await response.json()) as { text: string; content_state: string };
  };
  expect(await archivedText()).toMatchObject({ text: '虚构正文 900707', content_state: 'success' });

  // 停用：归档不随之删除。
  await card.getByRole('button', { name: '停止监控', exact: true }).click();
  await expect(card).toContainText('监控：已停止');
  expect((await archivedText()).text).toBe('虚构正文 900707');

  // 移除目标：只解除关联，归档仍可读。
  await card.getByRole('button', { name: '移除目标 900707', exact: true }).click();
  await expect(card).toContainText('目标已移除；已有归档保留。');
  await expect(card).toContainText('尚未添加指定目标。');
  expect((await archivedText()).text).toBe('虚构正文 900707');

  // 删除配置：身份和归档都保留，可按基线重新添加。
  await card.getByRole('button', { name: '删除监控配置', exact: true }).click();
  await expect(card).toContainText('监控配置已删除；身份和已有归档保留。');
  await expect(card).toContainText('配置已删除');
  expect((await archivedText()).text).toBe('虚构正文 900707');
  const retained = await page.request.get('/api/archive/dynamics?scope=up&uid=707&limit=10');
  expect(((await retained.json()) as { items: { id: string }[] }).items.map(item => item.id))
    .toEqual(['900707']);

  // 删除配置后阅读入口仍可用：单 UP 列表与详情都从真实 API 读到已有归档，刷新同样成立。
  await page.goto('/ups/707');
  await expect(page.getByRole('link', { name: '虚构晚风' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByText('虚构正文 900707', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('虚构正文 900707', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '阅读全文 900707' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/dynamics\/900707$/);
  await expect(page.getByRole('article')).toContainText('虚构正文 900707');
  await page.reload();
  await expect(page.getByRole('article')).toContainText('虚构正文 900707');
  // 安全隔离：页面不把任何凭据类信息写进浏览器存储或 Cookie。
  const stored = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
  }));
  expect(JSON.stringify(stored)).not.toMatch(/token|secret|credential|authorization/i);

  await page.goto('/manage/ups/707');
  await card.getByRole('button', { name: '重新添加监控', exact: true }).click();
  await expect(card).toContainText('监控：已停止');
  await expect(card.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');
  expect((await archivedText()).text).toBe('虚构正文 900707');

  // 身份与状态在列表页同样保留，且管理删除不等于内容删除。
  await page.goto('/manage');
  const link = page.getByRole('link', { name: '管理 UP 707', exact: true });
  await expect(link).toContainText('虚构晚风');
  await expect(link).toContainText('监控已停止');
  await page.reload();
  await expect(link).toContainText('监控已停止');
});

test('检查、发现与窗口状态按真实记录读取，读取本身不触发采集', async ({ page }) => {
  // 202 已在前序用例新增；这里保存近期 N=1 并启用，窗口成员来自真实的发现开关。
  await page.goto('/manage/ups/202');
  const card = upCard(page, '202');
  const recentN = card.getByRole('textbox', { name: '近期 N 条' });
  await expect(recentN).toHaveValue('10');
  await recentN.fill('1');
  await card.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(card).toContainText('已保存模式：近期 N 条；N：1。');
  await card.getByRole('button', { name: '启用监控', exact: true }).click();
  await expect(card).toContainText('监控：已启用');

  const checksPanel = page.getByRole('region', { name: '目标检查与归档状态' });
  const discoveryPanel = page.getByRole('region', { name: '近期发现与当前窗口' });
  // 打到状态接口的请求只由按钮触发：页面打开不自动读取，也不轮询。
  await expect(checksPanel.getByText('尚未读取检查状态。')).toBeVisible();
  await expect(discoveryPanel.getByText('尚未读取发现状态。')).toBeVisible();
  await checksPanel.getByRole('button', { name: '读取检查状态' }).click();
  await expect(checksPanel.getByText('尚无目标检查记录。')).toBeVisible();

  const collect = async (action: string) => {
    const response = await page.request.post('/api/test/collect', { data: { action, uid: '202' } });
    expect(response.status()).toBe(200);
    return (await response.json()) as { accepted: boolean[] };
  };
  const checksJson = async () =>
    (await (await page.request.get('/api/manage/ups/202/checks')).json());
  const archiveJson = async () =>
    (await (await page.request.get('/api/archive/dynamics?scope=up&uid=202&limit=10')).json());
  const checkHeader = () => checksPanel.getByRole('button', { name: /动态 9007199254740993123/ });

  // 真实 Collector 节拍：发现发布窗口，窗口成员尚未检查。
  expect((await collect('discover')).accepted).toEqual([true]);
  await discoveryPanel.getByRole('button', { name: '读取发现状态' }).click();
  await expect(discoveryPanel.getByText('本轮发现成功；不代表归档成功。')).toBeVisible();
  await expect(discoveryPanel.getByText('发现窗口已就绪；内容归档请另读检查状态。')).toBeVisible();
  await expect(discoveryPanel.getByText('读取时已保存模式：近期 N 条；N：1；监控：已启用。')).toBeVisible();
  await expect(discoveryPanel.getByRole('list', { name: '当前启用近期目标' }))
    .toContainText('9007199254740993123');

  const checksBefore = await checksJson();
  const archiveBefore = await archiveJson();
  await checksPanel.getByRole('button', { name: '重新读取检查状态' }).click();
  await expect(checkHeader()).toContainText('未检查');
  await checkHeader().click();
  await expect(checksPanel.getByText('执行：尚无检查工作')).toBeVisible();
  await expect(checksPanel.getByText('正文待处理；动态图待处理；评论待处理；回复待处理；评论图待处理。')).toBeVisible();
  // 页面只读：两次读取都没有产生检查记录或归档。
  expect(await checksJson()).toEqual(checksBefore);
  expect(await archiveJson()).toEqual(archiveBefore);

  // 第一次检查登记观察；第二次检查无变化，但不代表同步完成。
  expect((await collect('check')).accepted).toEqual([true]);
  await checksPanel.getByRole('button', { name: '重新读取检查状态' }).click();
  await expect(checkHeader()).toContainText('已检查');
  await expect(checksPanel.getByText('已检查，已登记观察。')).toBeVisible();
  await expect(checksPanel.getByText('执行：待同步')).toBeVisible();
  expect((await collect('check')).accepted).toEqual([true]);
  await checksPanel.getByRole('button', { name: '重新读取检查状态' }).click();
  await expect(checkHeader()).toContainText('检查无变化');
  await expect(checksPanel.getByText('检查无变化；不代表同步完成。')).toBeVisible();
  await expect(checksPanel.getByText('实际整轮成功：尚未成功')).toBeVisible();
  // UP 级与行内各自显示刚读到的时间（读取后不再沿用配置读取时的旧值）。
  await expect(checksPanel.getByText(/^最近检查：20\d\d-\d\d-\d\d \d\d:\d\d:\d\d$/)).toHaveCount(2);

  // 分项失败：根评论来源失败时正文已保存、评论仍待处理，整轮不算成功。
  expect((await page.request.post('/api/test/source-failure', { data: { reply: true } })).status()).toBe(200);
  expect((await collect('execute')).accepted).toEqual([true]);
  await checksPanel.getByRole('button', { name: '重新读取检查状态' }).click();
  await expect(checksPanel.getByText('正文已保存；动态图已保存；评论待处理；回复待处理；评论图待处理。'))
    .toBeVisible();
  await expect(checksPanel.getByText('根评论：根评论归档失败；保留已有归档，将在固定节拍重试。')).toBeVisible();
  await expect(checksPanel.getByText('评论整轮：根评论归档失败；保留已有归档，将在固定节拍重试。')).toBeVisible();
  await expect(checksPanel.getByText('评论同步：失败，待重试')).toBeVisible();
  await expect(checksPanel.getByText('同步：同步未全部完成，将在固定节拍重试。')).toBeVisible();
  await expect(checksPanel.getByText('实际整轮成功：尚未成功')).toBeVisible();
  await expect(checksPanel.getByText('最近成功：尚未成功')).toBeVisible();

  // 来源恢复后重试：整轮成功时间才出现，分项各自成功。
  expect((await page.request.post('/api/test/source-failure', { data: { reply: false } })).status()).toBe(200);
  expect((await collect('check')).accepted).toEqual([true]);
  expect((await collect('execute')).accepted).toEqual([true]);
  await checksPanel.getByRole('button', { name: '重新读取检查状态' }).click();
  await expect(checksPanel.getByText('正文已保存；动态图已保存；评论已保存；回复已保存；评论图已保存。'))
    .toBeVisible();
  await expect(checksPanel.getByText('评论同步：对应评论观察已完成')).toBeVisible();
  await expect(checksPanel.getByText(/^最近成功：20\d\d-/)).toBeVisible();
  await expect(checksPanel.getByText(/^实际整轮成功：20\d\d-/)).toBeVisible();

  // 固定上游失败：本轮发现失败并保留已发布窗口，可重试不等于已成功。
  expect((await page.request.post('/api/test/source-failure', { data: { feed: true } })).status()).toBe(200);
  expect((await collect('discover')).accepted).toEqual([false]);
  await discoveryPanel.getByRole('button', { name: '重新读取发现状态' }).click();
  await expect(discoveryPanel.getByText('本轮发现未完整完成。')).toBeVisible();
  await expect(discoveryPanel.getByText('发现未完成；保留已有可信结果与已发布窗口。')).toBeVisible();
  await expect(discoveryPanel.getByText('可在下一固定节拍重试；页面重读不会启动发现。')).toBeVisible();
  await expect(discoveryPanel.getByText('发现错误：来源暂不可用；保留已有可信结果。')).toBeVisible();
  await expect(discoveryPanel.getByText('本轮发现成功；不代表归档成功。')).toHaveCount(0);
  await expect(discoveryPanel.getByRole('list', { name: '当前启用近期目标' }))
    .toContainText('9007199254740993123');
  await expect(discoveryPanel.getByRole('list', { name: '最近可信发现目标' }))
    .toContainText('9007199254740993123');

  // 恢复固定上游，避免影响后续用例的采集行为。
  expect((await page.request.post('/api/test/source-failure', { data: { feed: false } })).status()).toBe(200);
  await page.reload();
  await expect(checksPanel.getByText('尚未读取检查状态。')).toBeVisible();
});
