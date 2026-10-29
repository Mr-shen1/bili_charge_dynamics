// @projects desktop-chromium, mobile-chromium
import { expect, test } from '@playwright/test';

// 骨架冒烟：六条正式路由可达、未知地址落到 not-found、mock 装配标识可见。
const readingPaths = ['/', '/ups/7', '/dynamics/abc', '/dynamics/abc/comments/root-1', '/no-such-page'];

test.describe('应用骨架', () => {
  test('六条正式路由渲染对应骨架页', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();

    await page.goto('/ups/7');
    await expect(page.getByRole('heading', { name: 'UP 7 动态' })).toBeVisible();

    await page.goto('/dynamics/abc');
    await expect(page.getByRole('heading', { name: '动态详情' })).toBeVisible();
    await expect(page.getByText('动态不存在或不可用')).toBeVisible();

    await page.goto('/dynamics/abc/comments/root-1');
    // 独立楼中楼已是真实页面：未知动态/根评论按普通可重试读取错误处理，不伪造内容。
    await expect(page.getByRole('button', { name: '评论详情，返回动态详情' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('相关回复读取失败，请重试。');

    // 管理两条路由已是真实页面：层级标题一致，不再有阶段 3 骨架占位文案。
    await page.goto('/manage');
    await expect(page.getByRole('heading', { name: 'UP 监控管理' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('阶段 3 迁移目标');

    await page.goto('/manage/ups/9');
    await expect(page.getByRole('heading', { name: 'UP 监控管理' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'UP 列表', exact: true })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('阶段 3 迁移目标');
  });

  test('阅读页没有公共品牌、导航与管理跳转', async ({ page }) => {
    for (const path of readingPaths) {
      await page.goto(path);
      await expect(page.locator('.app-header'), `${path} 不应有公共顶栏`).toHaveCount(0);
      await expect(page.getByRole('navigation', { name: '主导航' }), `${path} 不应有主导航`).toHaveCount(0);
      await expect(page.getByRole('link', { name: '监控管理' }), `${path} 不应有管理跳转`).toHaveCount(0);
      await expect(page.getByRole('link', { name: '归档' }), `${path} 不再保留旧阅读入口文案`).toHaveCount(0);
    }
  });

  test('管理入口独立可用，并保留自己的返回阅读导航', async ({ page }) => {
    await page.goto('/manage');
    const crumbs = page.getByRole('navigation', { name: '页面导航' });
    await expect(crumbs.getByRole('link', { name: '返回阅读' })).toHaveAttribute('href', '/');
    await expect(page.getByRole('heading', { name: 'UP 监控管理' })).toBeVisible();

    // 阅读页去掉管理入口不等于鉴权：独立地址仍然直达管理页。
    await crumbs.getByRole('link', { name: '返回阅读' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();
  });

  test('mock 装配有明确标识，自检页仍可回到阅读列表', async ({ page }) => {
    await page.goto('/');
    // mock 装配自带确定性归档，不依赖后端；列表读取路径同样经过页面组件。
    await expect(page.getByRole('article')).toHaveCount(10);
    await expect(page.locator('.app-badge')).toHaveText('mock');

    // 自检页只在 mock/fault 装配存在：导航留在自检页自身，不回到阅读页顶栏。
    await page.goto('/__preview-fixtures');
    await expect(page.getByRole('heading', { name: '图片预览与浏览器历史验证' })).toBeVisible();
    await page.getByRole('navigation', { name: '自检导航' }).getByRole('link', { name: '自检第二页' }).click();
    await expect(page).toHaveURL(/__preview-other$/);
    await page.getByRole('navigation', { name: '自检导航' }).getByRole('link', { name: '返回阅读' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();
  });

  test('未知地址显示不存在页并返回动态列表', async ({ page }) => {
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { name: '页面不存在' })).toBeVisible();
    await page.getByRole('link', { name: '返回动态列表' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: '全部动态' })).toBeVisible();
  });
});
