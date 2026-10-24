// @projects desktop-chromium, mobile-chromium
import { expect, test } from '@playwright/test';

// 骨架冒烟：六条正式路由可达、未知地址落到 not-found、mock 装配标识可见。
test.describe('应用骨架', () => {
  test('六条正式路由渲染对应骨架页', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();

    await page.goto('/ups/7');
    await expect(page.getByRole('heading', { name: 'UP 7 归档' })).toBeVisible();

    await page.goto('/dynamics/abc');
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect(page.getByText('动态不存在或不可用')).toBeVisible();

    await page.goto('/dynamics/abc/comments/root-1');
    // 独立楼中楼已是真实页面：未知动态/根评论按普通可重试读取错误处理，不伪造内容。
    await expect(page.getByRole('button', { name: '返回评论' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('相关回复读取失败，请重试。');

    await page.goto('/manage');
    await expect(page.getByRole('heading', { name: '监控管理' })).toBeVisible();

    await page.goto('/manage/ups/9');
    await expect(page.getByRole('heading', { name: '单 UP 管理' })).toBeVisible();
  });

  test('主导航可达，mock 装配有明确标识', async ({ page }) => {
    await page.goto('/');
    // mock 装配自带确定性归档，不依赖后端；列表读取路径同样经过页面组件。
    await expect(page.getByRole('article')).toHaveCount(10);
    const nav = page.getByRole('navigation', { name: '主导航' });
    await expect(nav.getByRole('link', { name: '归档' })).toBeVisible();
    await expect(nav.getByRole('link', { name: '监控管理' })).toBeVisible();
    await expect(nav.getByRole('link', { name: '图片自检' })).toBeVisible();
    await expect(page.locator('.app-badge')).toHaveText('mock');

    await nav.getByRole('link', { name: '图片自检' }).click();
    await expect(page).toHaveURL(/__preview-fixtures$/);
    await expect(page.getByRole('heading', { name: '图片预览与浏览器历史验证' })).toBeVisible();
  });

  test('未知地址显示不存在页并返回归档', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
    await page.getByRole('link', { name: '返回归档列表' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();
  });
});
