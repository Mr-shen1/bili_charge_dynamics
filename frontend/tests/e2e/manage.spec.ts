// @projects desktop-chromium-archive, mobile-chromium-archive
import { expect, test, type Page, type Route } from '@playwright/test';
import { checkDto, discoveryDto } from '../fixtures/management-dto';

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
    if (reply.status === 204) {
      await route.fulfill({ status: 204 });
      return;
    }
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

  test('删除配置的身份仍可管理页直达并说明归档保留，可重新添加但无启停入口', async ({ page }) => {
    const calls = await manageApi(page, () => ({ body: { ups: [up('789', { name: null, avatar_url: null, monitor: null })] } }));
    await page.goto('/manage/ups/789');
    const card = upCard(page, '789');
    await expect(card).toContainText('未知用户');
    await expect(card).toContainText('监控：无配置');
    await expect(card).toContainText('已有归档保留');
    await expect(card.getByRole('button', { name: '重新添加监控', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(停止|启用)监控$/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '删除监控配置', exact: true })).toHaveCount(0);
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
    await manageApi(page, call => {
      if (call.path.endsWith('/checks')) return { body: { checks: [checkDto({ id: '900' })] } };
      if (call.path.endsWith('/discovery')) return { body: discoveryDto({ uid: '123' }) };
      return call.path.endsWith('/targets') ? { body: { targets: [{ id: '900' }] } } : { body: { ups: [up('123')] } };
    });
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
      // 新增 UID 的输入框是 B1 报告 iOS 放大的现场，同样要 ≥16px。
      const listInputFontSizes = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(
        '.manage-add input, .manage-add textarea',
      )].filter(node => {
        const field = node as HTMLInputElement;
        return field.type !== 'radio' && field.type !== 'checkbox' && node.getBoundingClientRect().width > 0;
      }).map(node => Math.round(parseFloat(getComputedStyle(node).fontSize))));
      expect(listInputFontSizes.length).toBeGreaterThan(0);
      for (const size of listInputFontSizes) {
        expect(size, `${width}px 新增 UID 输入框字号不应小于 16px`).toBeGreaterThanOrEqual(16);
      }
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

      // 指定模式把配置草稿、关联目标与移除按钮也放进同一视口检查。
      await upCard(page, '123').getByText('指定动态 ID', { exact: true }).click();
      await expect(page.getByRole('textbox', { name: '动态 ID' })).toBeVisible();
      const specified = await page.evaluate(() => {
        const heights = [...document.querySelectorAll<HTMLElement>(
          '.el-radio, .manage-save, .manage-target-remove, .manage-target-submit',
        )].map(node => Math.round(node.getBoundingClientRect().height));
        const card = document.querySelector<HTMLElement>('.manage-up');
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          heights,
          cardWidth: Math.round(card?.getBoundingClientRect().width ?? 0),
          cardScrollWidth: card?.scrollWidth ?? 0,
          // 只看能聚焦放大的文本输入框：radio/checkbox 的隐藏原生控件不参与 iOS 自动缩放。
          inputFontSizes: [...document.querySelectorAll<HTMLInputElement>('.manage-up input')]
            .filter(node => node.type !== 'radio' && node.type !== 'checkbox'
              && node.getBoundingClientRect().width > 0)
            .map(node => Math.round(parseFloat(getComputedStyle(node).fontSize))),
        };
      });
      expect(specified.scrollWidth, `${width}px 指定模式不应横向溢出`).toBeLessThanOrEqual(specified.clientWidth);
      expect(specified.cardScrollWidth, `${width}px 指定模式卡片内容不应横向溢出`)
        .toBeLessThanOrEqual(specified.cardWidth);
      expect(specified.heights.length).toBeGreaterThanOrEqual(4);
      for (const height of specified.heights) {
        expect(height, `${width}px 指定模式触控区域高度`).toBeGreaterThanOrEqual(44);
      }
      // iOS Safari 对 font-size < 16px 的输入框聚焦时强制放大整页且失焦不还原（票据 15 F-15-02），
      // 输入类控件因此统一不小于 16px。
      expect(specified.inputFontSizes.length).toBeGreaterThan(0);
      for (const size of specified.inputFontSizes) {
        expect(size, `${width}px 输入框字号不应小于 16px`).toBeGreaterThanOrEqual(16);
      }

      // 检查与发现状态：读取按钮、折叠头与展开后的详情同样不横溢且可点按。
      await page.getByRole('button', { name: '读取检查状态' }).click();
      const checksRegion = page.getByRole('region', { name: '目标检查与归档状态' });
      await expect(checksRegion.getByRole('button', { name: /动态 900/ })).toBeVisible();
      await checksRegion.getByRole('button', { name: /动态 900/ }).click();
      await expect(checksRegion.getByText('检查无变化；不代表同步完成。')).toBeVisible();
      await page.getByRole('button', { name: '读取发现状态' }).click();
      await expect(page.getByRole('region', { name: '近期发现与当前窗口' })
        .getByText('本轮发现成功；不代表归档成功。')).toBeVisible();
      const status = await page.evaluate(() => {
        const heights = [...document.querySelectorAll<HTMLElement>(
          '.manage-read, .el-collapse-item__header',
        )].map(node => Math.round(node.getBoundingClientRect().height));
        const detail = document.querySelector<HTMLElement>('.manage-check-detail');
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          heights,
          detailWidth: Math.round(detail?.getBoundingClientRect().width ?? 0),
          detailScrollWidth: detail?.scrollWidth ?? 0,
        };
      });
      expect(status.scrollWidth, `${width}px 状态面板不应横向溢出`).toBeLessThanOrEqual(status.clientWidth);
      expect(status.detailScrollWidth, `${width}px 检查详情不应横向溢出`).toBeLessThanOrEqual(status.detailWidth);
      expect(status.heights.length).toBeGreaterThanOrEqual(3);
      for (const height of status.heights) {
        expect(height, `${width}px 状态控件触控区域高度`).toBeGreaterThanOrEqual(44);
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

test.describe('监控模式与指定目标', () => {
  function monitorOf(body: string | null) {
    return JSON.parse(body ?? '{}') as { mode: string; recent_n: number; enabled: boolean };
  }

  test('草稿只由保存提交，指定模式才读取与写入关联目标', async ({ page }) => {
    // 目标列表保持服务端真实状态：移除后再进入模式应重新读到当前关联。
    const targets = ['900'];
    const calls = await manageApi(page, call => {
      if (call.path === '/api/manage/ups' && call.method === 'GET') return { body: { ups: [up('123')] } };
      if (call.path === '/api/manage/ups/123/monitor' && call.method === 'PATCH') {
        return { body: up('123', { monitor: { ...monitorOf(call.body), last_checked_at: null, last_succeeded_at: null } }) };
      }
      if (call.path === '/api/manage/ups/123/targets' && call.method === 'GET') {
        return { body: { targets: targets.map(id => ({ id })) } };
      }
      if (call.path === '/api/manage/ups/123/targets' && call.method === 'POST') {
        const id = (JSON.parse(call.body ?? '{}') as { id: string }).id;
        if (id === '777') return { status: 409, body: { error: { code: 'TARGET_AUTHOR_MISMATCH', message: 'SECRET_TOKEN' } } };
        if (id === '888') return { status: 502, body: { error: { code: 'TARGET_UNVERIFIED', message: 'SECRET_TOKEN' } } };
        targets.push(id);
        return { status: 201, body: { id } };
      }
      if (call.path === '/api/manage/ups/123/targets/900' && call.method === 'DELETE') {
        targets.splice(targets.indexOf('900'), 1);
        return { status: 204 };
      }
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    await page.goto('/manage/ups/123');
    const card = upCard(page, '123');
    const recentN = card.getByRole('textbox', { name: '近期 N 条' });
    await expect(card).toContainText('已保存模式：近期 N 条；N：10。');
    await expect(recentN).toHaveValue('10');
    // 近期模式下不读取目标，只给出切换提示。
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/manage/ups']);

    await recentN.fill('25');
    await card.getByText('指定动态 ID', { exact: true }).click();
    await expect(recentN).toHaveCount(0);
    await expect(card.getByRole('list', { name: '指定动态目标列表' })).toContainText('900');
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
      'GET /api/manage/ups', 'GET /api/manage/ups/123/targets',
    ]);

    await card.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(card).toContainText('已保存模式：指定动态 ID。');
    const [saved] = calls.filter(call => call.method === 'PATCH');
    expect(monitorOf(saved!.body)).toEqual({ mode: 'specified', recent_n: 25, enabled: true });

    const targetInput = card.getByRole('textbox', { name: '动态 ID' });
    await targetInput.fill('777');
    await targetInput.press('Enter');
    await expect(card.getByRole('alert').filter({ hasText: '动态作者与所选 UP 不符' })).toBeVisible();
    await expect(targetInput).toHaveValue('777');
    await expect(page.locator('body')).not.toContainText('SECRET_TOKEN');

    await targetInput.fill('888');
    await targetInput.press('Enter');
    await expect(card.getByRole('alert').filter({ hasText: '无法确认动态归属' })).toBeVisible();
    await expect(targetInput).toHaveValue('888');

    await targetInput.fill('901');
    await targetInput.press('Enter');
    await expect(card.getByRole('alert').filter({ hasText: '归属校验通过，目标关联已保存。' })).toBeVisible();
    await expect(targetInput).toHaveValue('');
    await expect(card.getByRole('list', { name: '指定动态目标列表' })).toContainText('901');

    await card.getByRole('button', { name: '移除目标 900', exact: true }).click();
    await expect(card.getByRole('alert').filter({ hasText: '目标已移除；已有归档保留。' })).toBeVisible();
    await expect(card.getByRole('list', { name: '指定动态目标列表' })).not.toContainText('900');

    // 切回近期模式：默认不显示目标草稿，也不沿用目标区的反馈。
    await card.getByText('近期 N 条', { exact: true }).click();
    await expect(card.getByRole('textbox', { name: '动态 ID' })).toHaveCount(0);
    await expect(recentN).toHaveValue('25');
    await expect(card.getByRole('alert').filter({ hasText: '目标已移除' })).toHaveCount(0);

    // 再切回指定模式：重新读取目标，输入与旧反馈都不残留。
    await card.getByText('指定动态 ID', { exact: true }).click();
    await expect(card.getByRole('textbox', { name: '动态 ID' })).toHaveValue('');
    await expect(card.getByRole('list', { name: '指定动态目标列表' })).toContainText('901');
    await expect(card.getByRole('list', { name: '指定动态目标列表' })).not.toContainText('900');
    expect(calls.filter(call => call.path.endsWith('/targets') && call.method === 'GET')).toHaveLength(2);
  });

  test('模式控件可用键盘操作，校验失败的 N 不发请求', async ({ page }) => {
    const calls = await manageApi(page, call => {
      if (call.path === '/api/manage/ups') return { body: { ups: [up('123')] } };
      if (call.path.endsWith('/targets')) return { body: { targets: [] } };
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });
    await page.goto('/manage/ups/123');
    const card = upCard(page, '123');
    const recentN = card.getByRole('textbox', { name: '近期 N 条' });

    await recentN.fill('0');
    await card.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(card.getByRole('alert').filter({ hasText: '近期 N 须为正的安全整数' })).toBeVisible();
    await expect(recentN).toHaveValue('0');
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);

    // 键盘：聚焦模式单选后可用空格切换，不需要鼠标。
    const radio = card.getByRole('radio', { name: '指定动态 ID' });
    await radio.focus();
    await expect(radio).toBeFocused();
    await page.keyboard.press(' ');
    await expect(card.getByRole('textbox', { name: '动态 ID' })).toBeVisible();
    await expect(recentN).toHaveCount(0);
  });
});

test.describe('检查与发现状态', () => {
  test('状态只由按钮读取：键盘可重试与展开，错误不回显代理正文', async ({ page }) => {
    let checksFail = true;
    const calls = await manageApi(page, call => {
      if (call.path === '/api/manage/ups') return { body: { ups: [up('123')] } };
      if (call.path === '/api/manage/ups/123/checks') {
        if (checksFail) {
          checksFail = false;
          return { status: 503, body: { error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } } };
        }
        return { body: { checks: [checkDto({ id: '900' })] } };
      }
      if (call.path === '/api/manage/ups/123/discovery') return { body: discoveryDto({ uid: '123' }) };
      throw new Error(`unexpected ${call.method} ${call.path}`);
    });

    await page.goto('/manage/ups/123');
    await expect(upCard(page, '123')).toContainText('监控：已启用');
    // 打开单 UP 页只读身份与配置：检查/发现面板不自动请求，也不轮询。
    expect(calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/manage/ups']);

    const checksPanel = page.getByRole('region', { name: '目标检查与归档状态' });
    const readChecks = checksPanel.getByRole('button', { name: '读取检查状态' });
    await readChecks.focus();
    await expect(readChecks).toBeFocused();
    expect(await readChecks.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');

    // 读取失败只影响该面板：固定文案、原位重试，焦点不丢。
    await page.keyboard.press('Enter');
    await expect(checksPanel.getByRole('alert')).toContainText('配置存储暂不可用');
    await expect(page.locator('body')).not.toContainText('SECRET_TOKEN');
    const retryChecks = checksPanel.getByRole('button', { name: '重试读取检查状态' });
    await expect(retryChecks).toBeFocused();
    await page.keyboard.press('Enter');
    // 成功后按钮改为重新读取，未读取提示消失。
    await expect(checksPanel.getByRole('button', { name: '重新读取检查状态' })).toBeVisible();
    await expect(checksPanel.getByText('尚未读取检查状态。')).toHaveCount(0);

    // 检查详情默认收起：状态短语先给结论，展开才铺开计数与时间。
    const detail = checksPanel.getByText('检查无变化；不代表同步完成。');
    await expect(detail).toBeHidden();
    const header = checksPanel.getByRole('button', { name: /动态 900/ });
    await header.focus();
    await expect(header).toBeFocused();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(detail).toBeVisible();
    await expect(checksPanel.getByText('同步：同步未全部完成，将在固定节拍重试。')).toBeVisible();
    await expect(checksPanel.getByText('动态图：图片上传失败；保留已有归档，将在固定节拍重试。')).toBeVisible();

    const discoveryPanel = page.getByRole('region', { name: '近期发现与当前窗口' });
    await discoveryPanel.getByRole('button', { name: '读取发现状态' }).click();
    await expect(discoveryPanel.getByText('本轮发现成功；不代表归档成功。')).toBeVisible();
    await expect(discoveryPanel.getByText('读取时已保存模式：近期 N 条；N：2；监控：已启用。')).toBeVisible();
    await expect(discoveryPanel.getByRole('list', { name: '当前启用近期目标' })).toContainText('900707');
    // 远程读取不写入未提交草稿，也不产生额外写请求。
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.map(call => call.path)).toEqual([
      '/api/manage/ups',
      '/api/manage/ups/123/checks',
      '/api/manage/ups/123/checks',
      '/api/manage/ups/123/discovery',
    ]);
  });
});
