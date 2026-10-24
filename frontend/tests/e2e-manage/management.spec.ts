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
