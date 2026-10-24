// @projects desktop-chromium-archive, mobile-chromium-archive
import { expect, test, type Page, type Route } from '@playwright/test';

// 管理用例跑生产装配：只替换 HTTP 传输，仍经过真实 Adapter 的字段映射与错误白名单。
// mock/fault 装配不伪造管理成功，因此这些用例不在它们上重跑。
const largeUid = '900719925474099312345';

function up(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    uid,
    name: `虚构 ${uid}`,
    avatar_url: 'https://example.invalid/avatar.png',
    monitor: { mode: 'recent', recent_n: 10, enabled: true, last_checked_at: null, last_succeeded_at: null },
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: string | null;
}

type Reply = { status?: number; body?: unknown; json?: boolean; delayMs?: number };

/** 记录管理请求并返回受控响应；只有 /api/manage/** 被替换，其余装配保持生产行为。 */
async function manageApi(page: Page, handler: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  await page.route('**/api/manage/**', async (route: Route) => {
    const request = route.request();
    const call: Call = { method: request.method(), path: new URL(request.url()).pathname, body: request.postData() };
    calls.push(call);
    const reply = await handler(call);
    if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
    if (reply.json === false) {
      await route.fulfill({ status: reply.status ?? 200, contentType: 'text/html', body: String(reply.body ?? '') });
      return;
    }
    await route.fulfill({ status: reply.status ?? 200, json: reply.body as Record<string, unknown> });
  });
  return calls;
}

function upCard(page: Page, uid: string) {
  return page.getByRole('article', { name: `UP ${uid}`, exact: true });
}

test.describe('UP 监控管理', () => {
  test('列表直达与刷新：按身份与监控状态展示卡片，进入单 UP 页再返回', async ({ page }) => {
    const calls = await manageApi(page, () => ({ body: { ups: [
      up('123'),
      up('456', { monitor: { mode: 'recent', recent_n: 10, enabled: false, last_checked_at: null, last_succeeded_at: null } }),
      up('789', { name: null, avatar_url: null, monitor: null }),
    ] } }));
    await page.goto('/manage');
    const list = page.getByRole('list', { name: 'UP 列表' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list).toContainText('虚构 123');
    await expect(list).toContainText('监控已启用');
    await expect(list).toContainText('监控已停止');
    await expect(list).toContainText('配置已删除');
    await expect(list).toContainText('未知用户');
    expect(calls).toEqual([{ method: 'GET', path: '/api/manage/ups', body: null }]);

    await page.getByRole('link', { name: '管理 UP 123', exact: true }).click();
    await expect(page).toHaveURL(/\/manage\/ups\/123$/);
    await expect(upCard(page, '123')).toContainText('虚构 123');
    await expect(page.getByRole('button', { name: '停止监控', exact: true })).toBeVisible();

    await page.reload();
    await expect(upCard(page, '123')).toContainText('虚构 123');

    await page.getByRole('link', { name: 'UP 列表', exact: true }).click();
    await expect(page).toHaveURL(/\/manage$/);
    await expect(list.getByRole('listitem')).toHaveCount(3);
  });

  test('仅输入 UID 新增：回车提交保留字符串精度，昵称只作文字', async ({ page }) => {
    const ups: unknown[] = [];
    const calls = await manageApi(page, call => {
      if (call.method === 'GET') return { body: { ups } };
      const uid = JSON.parse(call.body ?? '{}').uid as string;
      const created = up(uid, { name: '<img src=x onerror=alert(1)>', avatar_url: '' });
      ups.push(created);
      return { status: 201, body: created };
    });
    await page.goto('/manage');
    await expect(page.getByText('尚未保存 UP，请输入 UID 添加。')).toBeVisible();

    const input = page.getByRole('textbox', { name: 'UP UID' });
    await input.fill(largeUid);
    await input.press('Enter');
    const link = page.getByRole('link', { name: `管理 UP ${largeUid}`, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.getByText('添加成功。')).toBeVisible();
    await expect(input).toHaveValue('');
    expect(calls.filter(call => call.method === 'POST')).toEqual([
      { method: 'POST', path: '/api/manage/ups', body: JSON.stringify({ uid: largeUid }) },
    ]);
    // 恶意昵称不得变成元素；头像空值回退应用自有占位。
    await expect(link.locator('img')).toHaveAttribute('src', '/default-avatar.svg');
    expect(await page.locator('img[src="x"]').count()).toBe(0);
  });

  test('UID 校验失败不发请求，阻塞时重复提交被阻止，失败保留输入', async ({ page }) => {
    let posts = 0;
    const calls = await manageApi(page, call => {
      if (call.method === 'GET') return { body: { ups: [] } };
      posts += 1;
      return posts === 1
        ? { status: 502, body: { error: { code: 'PROFILE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, delayMs: 300 }
        : { status: 201, body: up('123', { name: '虚构 123' }) };
    });
    await page.goto('/manage');
    const input = page.getByRole('textbox', { name: 'UP UID' });
    for (const uid of [' 123', '0123', '1e3', '9'.repeat(129)]) {
      await input.fill(uid);
      await input.press('Enter');
      await expect(page.getByRole('alert')).toContainText('UID 须为');
      await expect(input).toHaveValue(uid);
    }
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);

    await input.fill('123');
    await input.press('Enter');
    const submit = page.getByRole('button', { name: '正在添加…', exact: true });
    await expect(submit).toBeDisabled();
    await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('未取得 UP 资料');
    await expect(page.locator('body')).not.toContainText('SECRET_TOKEN');
    await expect(input).toHaveValue('123');
    expect(posts).toBe(1);

    await page.getByRole('button', { name: '重试添加', exact: true }).click();
    await expect(page.getByRole('link', { name: '管理 UP 123', exact: true })).toBeVisible();
    expect(posts).toBe(2);
  });

  test('启停提交已保存配置，失败原位重试且保留状态', async ({ page }) => {
    const writes: { body: string | null }[] = [];
    await manageApi(page, call => {
      if (call.method === 'GET') return { body: { ups: [up('123')] } };
      writes.push({ body: call.body });
      return writes.length === 1
        ? { status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } } }
        : { body: up('123', { monitor: { mode: 'recent', recent_n: 10, enabled: false, last_checked_at: null, last_succeeded_at: null } }) };
    });
    await page.goto('/manage/ups/123');
    const card = upCard(page, '123');
    await expect(card).toContainText('监控：已启用');
    await expect(page.getByRole('button', { name: '停止监控', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '停止监控', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('管理服务暂不可用');
    await expect(card).toContainText('监控：已启用');
    await expect(page.getByRole('button', { name: '重试停止', exact: true })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('SECRET_TOKEN');

    await page.getByRole('button', { name: '重试停止', exact: true }).click();
    await expect(card).toContainText('监控：已停止');
    await expect(card).toContainText('启停已保存。');
    await expect(page.getByRole('button', { name: '启用监控', exact: true })).toBeVisible();
    expect(writes.map(write => write.body)).toEqual([
      JSON.stringify({ mode: 'recent', recent_n: 10, enabled: false }),
      JSON.stringify({ mode: 'recent', recent_n: 10, enabled: false }),
    ]);
  });

  test('删除配置的身份仍可管理页直达并说明归档保留，无启停入口', async ({ page }) => {
    const calls = await manageApi(page, () => ({ body: { ups: [up('789', { name: null, avatar_url: null, monitor: null })] } }));
    await page.goto('/manage/ups/789');
    const card = upCard(page, '789');
    await expect(card).toContainText('未知用户');
    await expect(card).toContainText('监控：无配置');
    await expect(card).toContainText('已有归档保留');
    await expect(page.getByRole('button', { name: /监控$/ })).toHaveCount(0);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  test('读取失败原位重试', async ({ page }) => {
    let reads = 0;
    await manageApi(page, () => {
      reads += 1;
      return reads === 1
        ? { status: 503, body: { error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } } }
        : { body: { ups: [up('123')] } };
    });
    await page.goto('/manage');
    await expect(page.getByRole('alert')).toContainText('配置存储暂不可用');
    await expect(page.locator('body')).not.toContainText('SECRET_TOKEN');
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await expect(page.getByRole('list', { name: 'UP 列表' })).toBeVisible();
    expect(reads).toBe(2);
  });

  test('反代 401 只显示固定身份验证提示，不解析代理正文也不自动重试', async ({ page }) => {
    const calls = await manageApi(page, () => (
      { status: 401, json: false, body: '<html><h1>Unauthorized</h1>PRIVATE_PROXY_DETAIL</html>' }
    ));
    await page.goto('/manage');
    await expect(page.getByRole('alert')).toContainText('管理访问需要身份验证');
    await expect(page.locator('body')).not.toContainText('PRIVATE_PROXY_DETAIL');
    await expect(page.getByRole('button', { name: '重新读取', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'UP UID' })).toHaveCount(0);
    expect(calls).toEqual([{ method: 'GET', path: '/api/manage/ups', body: null }]);

    await page.goto('/manage/ups/123');
    await expect(page.getByRole('alert')).toContainText('管理访问需要身份验证');
    await expect(page.locator('body')).not.toContainText('PRIVATE_PROXY_DETAIL');
    await expect(page.getByRole('button', { name: '停止监控', exact: true })).toHaveCount(0);
    expect(calls).toHaveLength(2);
  });

  test('UP 不存在时可回到列表；四视口无横溢且控件高度不小于 44px', async ({ page }) => {
    await manageApi(page, () => ({ body: { ups: [up('123')] } }));
    await page.goto('/manage/ups/456');
    await expect(page.getByText('未找到该 UP，可能已被删除。')).toBeVisible();
    await page.getByRole('link', { name: '返回 UP 列表', exact: true }).click();
    await expect(page).toHaveURL(/\/manage$/);

    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      // 列表页：卡片、页头链接与提交按钮都可操作，且页面与卡片都不横向溢出。
      await page.goto('/manage');
      await expect(page.getByRole('list', { name: 'UP 列表' })).toBeVisible();
      const list = await page.evaluate(() => {
        const heights = [...document.querySelectorAll<HTMLElement>(
          '.app-nav a, .manage-crumbs a, .manage-up-link, .manage-submit',
        )].map(node => Math.round(node.getBoundingClientRect().height));
        const cards = [...document.querySelectorAll<HTMLElement>('.manage-up-link')];
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          heights,
          cards: cards.map(card => ({
            width: Math.round(card.getBoundingClientRect().width),
            scrollWidth: card.scrollWidth,
          })),
        };
      });
      expect(list.scrollWidth, `${width}px 管理列表不应横向溢出`).toBeLessThanOrEqual(list.clientWidth);
      expect(list.heights.length).toBeGreaterThan(0);
      for (const height of list.heights) {
        expect(height, `${width}px 管理列表触控区域高度`).toBeGreaterThanOrEqual(44);
      }
      for (const card of list.cards) {
        expect(card.scrollWidth, `${width}px 卡片内容不应横向溢出`).toBeLessThanOrEqual(card.width);
      }

      // 单 UP 页：身份卡与启停按钮同样要在四种宽度下可操作且不溢出。
      await page.goto('/manage/ups/123');
      await expect(upCard(page, '123')).toContainText('虚构 123');
      const single = await page.evaluate(() => {
        const heights = [...document.querySelectorAll<HTMLElement>(
          '.manage-crumbs a, .manage-up, .manage-toggle, .el-button',
        )].map(node => Math.round(node.getBoundingClientRect().height));
        const card = document.querySelector<HTMLElement>('.manage-up');
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          heights,
          cardWidth: Math.round(card?.getBoundingClientRect().width ?? 0),
          cardScrollWidth: card?.scrollWidth ?? 0,
        };
      });
      expect(single.scrollWidth, `${width}px 单 UP 页不应横向溢出`).toBeLessThanOrEqual(single.clientWidth);
      expect(single.cardScrollWidth, `${width}px 单 UP 卡片内容不应横向溢出`).toBeLessThanOrEqual(single.cardWidth);
      expect(single.heights.length).toBeGreaterThan(0);
      for (const height of single.heights) {
        expect(height, `${width}px 单 UP 页触控区域高度`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('键盘可完成新增与启停，焦点样式可见', async ({ page }) => {
    const ups: unknown[] = [];
    await manageApi(page, call => {
      if (call.method === 'GET') return { body: { ups } };
      if (call.method === 'POST') {
        const created = up('123', { name: '虚构 123' });
        ups.push(created);
        return { status: 201, body: created };
      }
      return { body: up('123', { monitor: { mode: 'recent', recent_n: 10, enabled: false, last_checked_at: null, last_succeeded_at: null } }) };
    });
    await page.goto('/manage');
    const input = page.getByRole('textbox', { name: 'UP UID' });
    await input.focus();
    await page.keyboard.type('123');
    await page.keyboard.press('Enter');
    const link = page.getByRole('link', { name: '管理 UP 123', exact: true });
    await expect(link).toBeVisible();
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/manage\/ups\/123$/);

    const toggle = page.getByRole('button', { name: '停止监控', exact: true });
    await toggle.focus();
    await expect(toggle).toBeFocused();
    const outline = await toggle.evaluate(node => getComputedStyle(node).outlineStyle);
    expect(outline).not.toBe('none');
    await page.keyboard.press('Enter');
    await expect(upCard(page, '123')).toContainText('监控：已停止');
  });
});
