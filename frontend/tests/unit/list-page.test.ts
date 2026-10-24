import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/vue';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView } from 'vue-router';
import ListPage from '../../src/pages/ListPage.vue';
import { createSessionPlugin } from '../../src/app/session';
import { createArchiveReader } from '../../src/data/archiveReader';
import type { AppSession } from '../../src/app/session';
import type { DynamicBatch, ReadResult } from '../../src/data/contracts';
import { archiveDynamic, archiveUser } from '../fixtures/archive';
import { createReader, deferred } from '../support/reader';

afterEach(cleanup);

const appUser = { id: '123', nickname: '归档作者', avatarUrl: null };

const RouterHost = defineComponent({ setup: () => () => h(RouterView) });
const DetailStub = defineComponent({ setup: () => () => h('h1', '动态详情') });

function archiveRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'list', component: ListPage },
      { path: '/ups/:upId', component: ListPage, props: true },
      { path: '/dynamics/:dynamicId', name: 'detail', component: DetailStub },
    ],
  });
}

async function show(reader: AppSession['reader'], path = '/') {
  const router = archiveRouter();
  await router.push(path);
  await router.isReady();
  const view = render(RouterHost, { global: { plugins: [router, createSessionPlugin({ reader })] } });
  return { router, view };
}

function listTransport(total: number, urls: string[]) {
  return createArchiveReader(async url => {
    if (url === '/api/archive/ups') return Response.json({ ups: [archiveUser('123', '归档作者')] });
    urls.push(url);
    const cursor = new URL(url, 'http://local').searchParams.get('cursor');
    const offset = cursor === null ? 0 : Number(cursor);
    const items = Array.from({ length: Math.min(10, total - offset) }, (_value, index) => archiveDynamic(offset + index + 1));
    return Response.json({ items, next_cursor: offset + 10 < total ? String(offset + 10) : null });
  });
}

describe('归档列表页面', () => {
  it('默认全部，25 条按 10/10/5 连续追加并结束提示', async () => {
    const urls: string[] = [];
    await show(listTransport(25, urls));
    expect(await screen.findByText('归档正文 1')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(10);
    expect(screen.getByRole('heading', { name: '全部动态' })).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('归档正文 20');
    expect(screen.getAllByRole('article')).toHaveLength(20);

    await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('归档正文 25');
    expect(screen.getAllByRole('article')).toHaveLength(25);
    expect(screen.getByText('动态已加载完毕')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(urls).toEqual([
      '/api/archive/dynamics?limit=10&scope=all',
      '/api/archive/dynamics?limit=10&scope=all&cursor=10',
      '/api/archive/dynamics?limit=10&scope=all&cursor=20',
    ]);
  });

  it('追加去重，不因服务端重复或跨批重复多出卡片', async () => {
    let page = 0;
    const reader = createReader({
      readList: async () => {
        page += 1;
        return page === 1
          ? { status: 'success', data: { items: Array.from({ length: 10 }, (_value, index) => ({
            id: String(1001 + index), author: appUser, publishedAt: null,
            text: `归档正文 ${index + 1}`, commentCount: 0,
          })), nextCursor: 'next' } }
          : { status: 'success', data: { items: [
            { id: '1009', author: appUser, publishedAt: null, text: '跨批重复', commentCount: 0 },
            { id: '1011', author: appUser, publishedAt: null, text: '归档正文 11', commentCount: 0 },
            { id: '1011', author: appUser, publishedAt: null, text: '同批重复', commentCount: 0 },
          ], nextCursor: null } };
      },
    });
    await show(reader);
    await screen.findByText('归档正文 10');
    await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('归档正文 11');
    expect(screen.getAllByRole('article')).toHaveLength(11);
    expect(document.querySelectorAll('[data-reading-id="1011"]')).toHaveLength(1);
  });

  it('同批重复点击只读一次，失败保留原批并可用同一 cursor 重试', async () => {
    const urls: string[] = [];
    let failed = false;
    const reader = createArchiveReader(async url => {
      if (url === '/api/archive/ups') return Response.json({ ups: [] });
      urls.push(url);
      if (url.includes('cursor=') && !failed) {
        failed = true;
        throw new Error('SECRET_TOKEN');
      }
      return Response.json({
        items: [archiveDynamic(url.includes('cursor=') ? 2 : 1)],
        next_cursor: url.includes('cursor=') ? null : 'same-batch',
      });
    });
    await show(reader);
    await screen.findByText('归档正文 1');
    await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(screen.getByRole('alert').textContent).toBe('动态追加读取失败，请重试。');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('SECRET_TOKEN');

    await fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('归档正文 2');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('动态已加载完毕')).toBeTruthy();
    expect(urls).toEqual([
      '/api/archive/dynamics?limit=10&scope=all',
      '/api/archive/dynamics?limit=10&scope=all&cursor=same-batch',
      '/api/archive/dynamics?limit=10&scope=all&cursor=same-batch',
    ]);
  });

  it('切换 scope 后忽略旧 scope 的迟到成功与失败，不清掉新加载态', async () => {
    for (const status of ['success', 'error', 'cancelled'] as const) {
      cleanup();
      const pending = deferred<ReadResult<DynamicBatch>>();
      const user = { id: '456', nickname: '作者二', avatarUrl: null };
      const reader = createReader({
        readUps: async () => ({ status: 'success', data: [user] }),
        readList: input => input.scope.kind === 'all'
          ? pending.promise
          : Promise.resolve({ status: 'success', data: { items: [{
            id: '2001', author: user, publishedAt: null, text: `作者二正文 ${status}`, commentCount: null,
          }], nextCursor: null } }),
      });
      await show(reader);
      expect(await screen.findByText('动态列表加载中…')).toBeTruthy();
      await fireEvent.click(await screen.findByRole('link', { name: '作者二' }));
      await screen.findByText(`作者二正文 ${status}`);

      pending.resolve(status === 'success'
        ? { status: 'success', data: { items: [{ id: '1001', author: user, publishedAt: null, text: '旧 scope 正文', commentCount: 0 }], nextCursor: null } }
        : { status });
      await waitFor(() => expect(screen.queryByText('旧 scope 正文')).toBeNull());
      expect(screen.getByText(`作者二正文 ${status}`)).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    }
  });

  it('cursor 失效保留旧批并明确重新开始，重新开始替换为新列表', async () => {
    const urls: string[] = [];
    const reader = createArchiveReader(async url => {
      if (url === '/api/archive/ups') return Response.json({ ups: [] });
      urls.push(url);
      if (url.includes('cursor=')) return Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 422 });
      return Response.json({ items: [archiveDynamic(1, { text: urls.length > 2 ? '重新开始的新归档' : '旧首批' })], next_cursor: 'expired' });
    });
    await show(reader);
    await screen.findByText('旧首批');
    await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect((await screen.findByRole('alert')).textContent).toBe('分页已失效，请重新开始读取。');
    expect(screen.getByText('旧首批')).toBeTruthy();
    expect(screen.queryByText('动态已加载完毕')).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: '重新开始' }));
    await screen.findByText('重新开始的新归档');
    expect(screen.queryByText('旧首批')).toBeNull();
    expect(urls).toEqual([
      '/api/archive/dynamics?limit=10&scope=all',
      '/api/archive/dynamics?limit=10&scope=all&cursor=expired',
      '/api/archive/dynamics?limit=10&scope=all',
    ]);
  });

  it('未知 UP、已知空归档与读取失败分别表达', async () => {
    const unknown = createArchiveReader(async url => url === '/api/archive/ups'
      ? Response.json({ ups: [] })
      : Response.json({ error: { code: 'UNKNOWN_UP' } }, { status: 404 }));
    const unknownView = await show(unknown, '/ups/999');
    expect(await screen.findByText('UP 不存在')).toBeTruthy();
    expect(screen.queryByText('暂无动态')).toBeNull();
    unknownView.view.unmount();

    const empty = createArchiveReader(async url => url === '/api/archive/ups'
      ? Response.json({ ups: [] })
      : Response.json({ items: [], next_cursor: null }));
    const emptyView = await show(empty, '/ups/456');
    expect(await screen.findByText('暂无动态')).toBeTruthy();
    expect(screen.queryByText('UP 不存在')).toBeNull();
    emptyView.view.unmount();

    let attempt = 0;
    const reader = createArchiveReader(async url => {
      if (url === '/api/archive/ups') return Response.json({ ups: [] });
      attempt += 1;
      if (attempt === 1) throw new Error('SECRET_TOKEN');
      return Response.json({ items: [archiveDynamic(1)], next_cursor: null });
    });
    await show(reader);
    expect((await screen.findByRole('alert')).textContent).toBe('动态列表读取失败，请重试。');
    expect(document.body.textContent).not.toContain('SECRET_TOKEN');
    await fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('归档正文 1');
  });

  it('UP 不在当前身份列表时仍可读取其已有归档', async () => {
    const reader = createArchiveReader(async url => {
      if (url === '/api/archive/ups') return Response.json({ ups: [] });
      return Response.json({ items: [archiveDynamic(7, {
        text: '已删除配置的 UP 归档',
        author: { id: '789', nickname: '已停止监控', avatar_url: null },
      })], next_cursor: null });
    });
    await show(reader, '/ups/789');
    expect(await screen.findByText('已删除配置的 UP 归档')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'UP 789 归档' })).toBeTruthy();
    expect(screen.queryByText('UP 不存在')).toBeNull();
  });

  it('UP 身份列表失败不阻断归档读取，可单独重读', async () => {
    let upsAttempts = 0;
    const reader = createArchiveReader(async url => {
      if (url === '/api/archive/ups') {
        upsAttempts += 1;
        if (upsAttempts === 1) throw new Error('SECRET_TOKEN');
        return Response.json({ ups: [archiveUser('456', '作者二')] });
      }
      return Response.json({ items: [archiveDynamic(1, { text: '归档仍可读' })], next_cursor: null });
    });
    await show(reader);
    expect(await screen.findByText('归档仍可读')).toBeTruthy();
    expect(await screen.findByText('UP 身份列表读取失败。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SECRET_TOKEN');
    await fireEvent.click(screen.getByRole('button', { name: '重读 UP 列表' }));
    expect(await screen.findByRole('link', { name: '作者二' })).toBeTruthy();
    expect(screen.queryByText('UP 身份列表读取失败。')).toBeNull();
  });

  it('正文按纯文本安全展示，计数零/未知与时间兜底正确，不出现编辑信息', async () => {
    const text = `换行\nemoji 😀 https://example.test/${'a'.repeat(180)} <img src=x onerror=alert(1)> <script>alert(2)</script>`;
    const reader = createArchiveReader(async url => Response.json(url === '/api/archive/ups' ? { ups: [] } : {
      items: [archiveDynamic(1, {
        text,
        author: { id: '123', nickname: null, avatar_url: 'javascript:alert(1)' },
        published_at: null,
        source_comment_count: null,
        title: '标题 <b>不作为节点</b>',
      }), archiveDynamic(2, { source_comment_count: 0 })],
      next_cursor: null,
    }));
    await show(reader);
    const card = (await screen.findByText('未知用户')).closest('article');
    expect(card).toBeTruthy();
    if (!card) throw new Error('缺少动态卡片');
    expect(card.textContent).toContain('换行');
    expect(card.textContent).toContain('😀');
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card.textContent).toContain('标题 <b>不作为节点</b>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('article b')).toBeNull();
    expect(screen.getByText('时间未知')).toBeTruthy();
    expect(screen.getByRole('button', { name: '来源评论 —' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '来源评论 0' })).toBeTruthy();
    expect(card.textContent).not.toContain('编辑');
    expect(card.textContent).not.toContain('2026-03-02 13:01');
  });

  it('卡片提供独立阅读链接，选中文字时不触发导航', async () => {
    const reader = createArchiveReader(async url => Response.json(url === '/api/archive/ups'
      ? { ups: [] }
      : { items: [archiveDynamic(1)], next_cursor: null }));
    const { router } = await show(reader);
    await screen.findByText('归档正文 1');
    const link = screen.getByRole('link', { name: '阅读全文 1001' });
    expect(link.getAttribute('href')).toBe('/dynamics/1001');

    const text = screen.getByText('归档正文 1');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(text);
    selection?.removeAllRanges();
    selection?.addRange(range);
    await fireEvent.click(text);
    expect(router.currentRoute.value.name).toBe('list');

    selection?.removeAllRanges();
    await fireEvent.click(screen.getByRole('article'));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  });
});
