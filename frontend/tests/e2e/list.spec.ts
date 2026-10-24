import { expect, test, type Page } from '@playwright/test';
import { closeViewer, counter, viewer, viewerImage } from './support';

// 列表用例跑生产装配：这里只替换 HTTP 传输，仍经过真实 Adapter 的 DTO 映射；
// mock/fault 装配自带受控归档数据，不参与这些请求断言。
const users = [
  { id: '123', nickname: '归档作者一', avatar_url: null },
  { id: '456', nickname: '归档作者二', avatar_url: null },
  ...Array.from({ length: 10 }, (_value, index) => ({
    id: String(700 + index),
    nickname: `监控中的作者 ${index + 1}`,
    avatar_url: null,
  })),
];

function dynamic(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id: String(1000 + id),
    author: users[0],
    published_at: '2026-03-01T10:03:04+08:00',
    edited_at: '2026-03-02T13:01+08:00',
    edit_status: 'observed',
    text: `归档正文 ${id}`,
    content_state: 'success',
    last_attempt: 'success',
    source_comment_count: id,
    local_comment_count: 0,
    media_sources: [],
    comment_locator: null,
    observed_version: null,
    synced_version: null,
    work: { text: 'success', media: 'success', comments: 'success' },
    ...overrides,
  };
}

type Reply = { status?: number; body: unknown };

async function mockApi(page: Page, handler: (url: URL) => Reply | Promise<Reply>) {
  const requests: { method: string; path: string; search: string }[] = [];
  await page.route('**/api/archive/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname, search: url.search });
    const reply = await handler(url);
    await route.fulfill({ status: reply.status ?? 200, json: reply.body as Record<string, unknown> });
  });
  return requests;
}

function paged(items: unknown[], url: URL) {
  const cursor = url.searchParams.get('cursor');
  const offset = cursor === null ? 0 : Number(cursor);
  const limit = Number(url.searchParams.get('limit') ?? '10');
  return { body: {
    items: items.slice(offset, offset + limit),
    next_cursor: offset + limit < items.length ? String(offset + limit) : null,
  } };
}

function serveDynamics(scopeItems: Record<string, unknown[]>) {
  return (url: URL): Reply => {
    if (url.pathname === '/api/archive/ups') return { body: { ups: users } };
    const scope = url.searchParams.get('scope');
    const uid = url.searchParams.get('uid') ?? '';
    const items = scope === 'up' ? scopeItems[uid] ?? [] : scopeItems.all ?? [];
    return paged(items, url);
  };
}

test.describe('归档列表读取', () => {
  test('25 条按 10/10/5 追加，结束提示与 cursor 请求正确', async ({ page }) => {
    const items = Array.from({ length: 25 }, (_value, index) => dynamic(index + 1));
    const requests = await mockApi(page, serveDynamics({ all: items }));
    await page.goto('/');

    await expect(page.getByRole('article')).toHaveCount(10);
    await expect(page.getByText('归档正文 1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(20);
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('article')).toHaveCount(25);
    await expect(page.getByText('动态已加载完毕')).toBeVisible();
    await expect(page.getByRole('button', { name: '加载更多' })).toHaveCount(0);

    const listRequests = requests.filter(request => request.path === '/api/archive/dynamics');
    expect(listRequests.map(request => request.search)).toEqual([
      '?limit=10&scope=all',
      '?limit=10&scope=all&cursor=10',
      '?limit=10&scope=all&cursor=20',
    ]);
    expect(listRequests.every(request => request.method === 'GET')).toBe(true);
  });

  test('四视口无页面横溢，UP 条只在内部横滚', async ({ page }) => {
    const text = `长地址 https://example.test/${'a'.repeat(220)} 结束`;
    const items = Array.from({ length: 10 }, (_value, index) =>
      dynamic(index + 1, index === 0 ? { text, source_comment_count: null, published_at: null } : {}));
    await mockApi(page, serveDynamics({ all: items }));

    for (const width of [360, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.getByRole('article')).toHaveCount(10);
      const metrics = await page.evaluate(() => {
        const strip = document.querySelector('.up-strip');
        return {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          stripScroll: strip?.scrollWidth ?? 0,
          stripClient: strip?.clientWidth ?? 0,
        };
      });
      expect(metrics.scrollWidth, `${width}px 页面不应横向溢出`).toBeLessThanOrEqual(metrics.clientWidth);
      expect(metrics.stripScroll, `${width}px UP 条应在容器内横滚`).toBeGreaterThan(metrics.stripClient);
      await expect(page.getByRole('link', { name: '全部归档' })).toHaveAttribute('aria-current', 'page');
    }
  });

  test('正文实际超过 6 行才折叠，宽度变化后重新判断并可展开收起', async ({ page }) => {
    const long = `长正文${'测'.repeat(176)}`;
    const items = [
      dynamic(1, { text: `短正文${'短'.repeat(8)}` }),
      dynamic(2, { text: long }),
    ];
    await mockApi(page, serveDynamics({ all: items }));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('article')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '展开正文' })).toHaveCount(0);

    await page.setViewportSize({ width: 360, height: 900 });
    const toggle = page.getByRole('button', { name: '展开正文' });
    await expect(toggle).toHaveCount(1);
    const paragraph = page.getByText(long, { exact: true });
    expect(await paragraph.getAttribute('class')).toContain('collapsed');

    await toggle.click();
    const collapse = page.getByRole('button', { name: '收起正文' });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    expect(await paragraph.getAttribute('class')).not.toContain('collapsed');

    await collapse.click();
    await expect(page.getByRole('button', { name: '展开正文' })).toHaveAttribute('aria-expanded', 'false');
    expect(await paragraph.getAttribute('class')).toContain('collapsed');
  });

  test('未知 UP、已知空归档与读取失败分别表达，失败可重试', async ({ page }) => {
    let listAttempts = 0;
    await mockApi(page, url => {
      if (url.pathname === '/api/archive/ups') return { body: { ups: users } };
      const uid = url.searchParams.get('uid');
      if (uid === '999') return { status: 404, body: { error: { code: 'UNKNOWN_UP' } } };
      if (uid === '456') return { body: { items: [], next_cursor: null } };
      listAttempts += 1;
      if (listAttempts === 1) return { status: 503, body: { error: { message: 'SECRET_TOKEN' } } };
      return { body: { items: [dynamic(1, { text: '重试后的归档' })], next_cursor: null } };
    });

    await page.goto('/ups/999');
    await expect(page.getByText('UP 不存在', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无动态', { exact: true })).toHaveCount(0);

    await page.goto('/ups/456');
    await expect(page.getByText('暂无动态', { exact: true })).toBeVisible();
    await expect(page.getByText('UP 不存在', { exact: true })).toHaveCount(0);

    await page.goto('/');
    await expect(page.getByRole('alert')).toHaveText('动态列表读取失败，请重试。');
    await expect(page.locator('body')).not.toContainText('SECRET_TOKEN');
    await page.getByRole('button', { name: '重试' }).click();
    await expect(page.getByText('重试后的归档', { exact: true })).toBeVisible();
  });

  test('cursor 失效保留旧批并重新开始，切 scope 后不混入旧内容', async ({ page }) => {
    const first = [dynamic(1, { text: '旧首批' })];
    let expired = false;
    await mockApi(page, url => {
      if (url.pathname === '/api/archive/ups') return { body: { ups: users } };
      if (url.searchParams.get('scope') === 'up' && url.searchParams.get('uid') === '456') {
        return { body: { items: [dynamic(2, { text: '作者二归档', author: users[1] })], next_cursor: null } };
      }
      if (url.searchParams.get('cursor') !== null) {
        expired = true;
        return { status: 422, body: { error: { code: 'INVALID_INPUT' } } };
      }
      return expired
        ? { body: { items: [dynamic(3, { text: '重新开始的新归档' })], next_cursor: null } }
        : { body: { items: first, next_cursor: 'expired' } };
    });
    await page.goto('/');
    await expect(page.getByText('旧首批', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '加载更多' }).click();
    await expect(page.getByRole('alert')).toHaveText('分页已失效，请重新开始读取。');
    await expect(page.getByText('旧首批', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '重新开始' }).click();
    await expect(page.getByText('重新开始的新归档', { exact: true })).toBeVisible();
    await expect(page.getByText('旧首批', { exact: true })).toHaveCount(0);

    await page.getByRole('link', { name: '归档作者二' }).click();
    await expect(page).toHaveURL(/\/ups\/456$/);
    await expect(page.getByText('作者二归档', { exact: true })).toBeVisible();
    await expect(page.getByText('重新开始的新归档', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: '归档作者二' })).toHaveAttribute('aria-current', 'page');
  });

  test('卡片与键盘进入详情，普通读取不触发采集或上传', async ({ page }) => {
    const items = [dynamic(1, { text: '可点击归档' })];
    const requests = await mockApi(page, serveDynamics({ all: items }));
    const network: { method: string; path: string }[] = [];
    page.on('request', request => {
      network.push({ method: request.method(), path: new URL(request.url()).pathname });
    });
    await page.goto('/');
    await expect(page.getByText('可点击归档', { exact: true })).toBeVisible();

    const link = page.getByRole('link', { name: '阅读全文 1001' });
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/dynamics\/1001$/);

    await page.goto('/');
    await page.getByText('可点击归档', { exact: true }).click();
    await expect(page).toHaveURL(/\/dynamics\/1001$/);

    expect(requests.every(request => request.method === 'GET')).toBe(true);
    const apiRequests = network.filter(request => request.path.startsWith('/api'));
    expect(apiRequests.every(request => request.method === 'GET' && request.path.startsWith('/api/archive/'))).toBe(true);
    expect(network.some(request => /collect|upload|oss/i.test(request.path))).toBe(false);
  });
});

test.describe('归档图片读取', () => {
  test('生产共用公开地址按图片状态渲染，打开预览只重发所点地址', async ({ page }) => {
    const shared = [1, 2, 3, 4, 5].map(index => `https://cdn.example.test/archive/shared-${index}.svg`);
    const imageRequests: string[] = [];
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#0f766e"/></svg>';
    await page.route('https://cdn.example.test/**', route => {
      imageRequests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        headers: { 'cache-control': 'no-store' },
        body: svg,
      });
    });
    const media = [
      { id: 'm1', owner: { type: 'dynamic', id: '1001' }, status: 'success', public_url: shared[0], width: 800, height: 600 },
      // 未上传没有公开地址，不请求来源。
      { id: 'm2', owner: { type: 'dynamic', id: '1001' }, status: 'pending', public_url: null, width: null, height: null },
      // 共用地址：缩略图与预览使用同一个公开地址。
      { id: 'm3', owner: { type: 'dynamic', id: '1001' }, status: 'success', public_url: shared[2], width: 800, height: 600 },
      // 成功状态但公开地址不是可用 https：读取层判为无效，不请求该地址。
      { id: 'm4', owner: { type: 'dynamic', id: '1001' }, status: 'success', public_url: 'http://insecure.example.test/x.svg', width: null, height: null },
      // 归档失败没有公开地址。
      { id: 'm5', owner: { type: 'dynamic', id: '1001' }, status: 'failed', public_url: null, width: null, height: null },
    ];
    await mockApi(page, serveDynamics({ all: [dynamic(1, { media })] }));
    await page.goto('/');

    const card = page.getByRole('article');
    await expect(card).toHaveCount(1);
    const tiles = card.getByRole('button', { name: /^预览动态图片 / });
    await expect(tiles).toHaveCount(5);
    await expect(card.getByText('图片待归档')).toBeVisible();
    await expect(card.getByText('图片归档失败')).toBeVisible();
    await expect(card.getByText('归档图片地址不可用')).toBeVisible();

    // 共用地址：缩略图与预览都使用公开地址；点击第三张只请求该地址。
    await expect.poll(async () => imageRequests.filter(url => url === shared[0]).length).toBeGreaterThan(0);
    imageRequests.length = 0;
    await tiles.nth(2).click();
    await expect(viewer(page)).toBeVisible();
    await expect(counter(page)).toHaveText('3 / 5');
    await expect.poll(async () => viewerImage(page).getAttribute('src')).toBe(shared[2]);
    await expect.poll(async () => imageRequests.filter(url => url === shared[2]).length).toBeGreaterThanOrEqual(1);
    // 不预下载同组其他图片，也不请求来源媒体地址。
    expect(imageRequests.filter(url => url !== shared[2])).toEqual([]);
    expect(imageRequests.some(url => url.includes('upstream.example.test'))).toBe(false);

    await closeViewer(page);
    await expect(viewer(page)).toHaveCount(0);
  });
});
