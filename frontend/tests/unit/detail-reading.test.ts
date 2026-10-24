import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, expect, it } from 'vitest';
import { createArchiveReader } from '../../src/data/archiveReader';
import type { DetailResult, DynamicBatch, ReadResult } from '../../src/data/contracts';
import { archiveDynamic, archiveMedia, archiveUser } from '../fixtures/archive';
import { createReader, deferred } from '../support/reader';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { showApp } from '../support/app';

const show = showApp;

let layout: FakeLayout | null = null;
afterEach(() => {
  cleanup();
  layout?.restore();
  layout = null;
});

/** 列表读取 + 指定动态详情；详情用到 /api/archive/dynamics/:id。 */
function archiveTransport(options: { total?: number; detailIds?: readonly string[]; failDetail?: boolean } = {}) {
  const total = options.total ?? 25;
  const detailIds = options.detailIds ?? Array.from({ length: total }, (_value, index) => String(1001 + index));
  const urls: string[] = [];
  const reader = createArchiveReader(async url => {
    if (url === '/api/archive/ups') return Response.json({ ups: [archiveUser('123', '归档作者')] });
    const detail = /^\/api\/archive\/dynamics\/([^/?]+)$/.exec(url);
    if (detail) {
      urls.push(url);
      if (options.failDetail) throw new Error('SECRET_TOKEN');
      return detailIds.includes(detail[1]!)
        ? Response.json(archiveDynamic(Number(detail[1]!.slice(3))))
        : Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
    }
    urls.push(url);
    const cursor = new URL(url, 'http://local').searchParams.get('cursor');
    const offset = cursor === null ? 0 : Number(cursor);
    const items = Array.from({ length: Math.min(10, total - offset) }, (_value, index) => archiveDynamic(offset + index + 1));
    return Response.json({ items, next_cursor: offset + 10 < total ? String(offset + 10) : null });
  });
  return { reader, urls };
}

it('卡片进入详情顶部并全文展示，返回恢复来源列表的已加载批次与位置', async () => {
  layout = installFakeLayout();
  const { reader } = archiveTransport();
  const router = await show(reader);
  await screen.findByText('归档正文 1');
  await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByText('归档正文 20');
  const cards = screen.getAllByRole('article');
  layout.setScrollY(900);
  layout.scrollTo.mockClear();
  await fireEvent.click(within(cards[3]!).getByRole('link', { name: '阅读全文 1004' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const detail = await screen.findByRole('article');
  expect(within(detail).getByText('归档正文 4')).toBeTruthy();
  // 详情正文全文显示：没有列表的折叠入口。
  expect(within(detail).queryByRole('button', { name: '展开正文' })).toBeNull();
  await waitFor(() => expect(layout?.scrollY()).toBe(0));

  // 返回后布局变化 40px，仍按稳定锚点保持原视口偏移。
  layout.shift = 40;
  layout.scrollTo.mockClear();
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  expect(await screen.findByText('归档正文 20')).toBeTruthy();
  expect(screen.getAllByRole('article')).toHaveLength(20);
  await waitFor(() => expect(layout?.scrollY()).toBe(940));
  expect(router.currentRoute.value.path).toBe('/');
});

it('从单 UP 来源进入详情，返回仍在同一 scope 并恢复已加载批次', async () => {
  layout = installFakeLayout();
  const { reader } = archiveTransport({ total: 12 });
  const router = await show(reader, '/ups/123');
  await screen.findByText('归档正文 1');
  await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByText('归档正文 12');

  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await screen.findByRole('heading', { name: '动态详情' });
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/ups/123'));
  expect(await screen.findByText('归档正文 12')).toBeTruthy();
  expect(screen.getAllByRole('article')).toHaveLength(12);
});

it('同一动态的多次访问各存快照，后退/前进分别恢复自己的位置', async () => {
  layout = installFakeLayout();
  const { reader } = archiveTransport({ total: 10 });
  const router = await show(reader);
  await screen.findByText('归档正文 1');

  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await screen.findByRole('heading', { name: '动态详情' });
  layout.setScrollY(600);
  // 从详情进入新列表访问，保留第一次访问在历史记录中。
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  await screen.findByText('归档正文 1');

  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await screen.findByRole('heading', { name: '动态详情' });
  layout.setScrollY(300);

  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await waitFor(() => expect(layout?.scrollY()).toBe(600));

  await router.go(1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  await router.go(1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await waitFor(() => expect(layout?.scrollY()).toBe(300));
});

it('回到首页的新访问不继承旧列表访问的批次与位置，旧访问快照也不被覆盖', async () => {
  layout = installFakeLayout();
  const { reader } = archiveTransport({ total: 25 });
  const router = await show(reader);
  await screen.findByText('归档正文 1');
  await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await screen.findByText('归档正文 20');
  layout.setScrollY(700);

  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await screen.findByRole('heading', { name: '动态详情' });

  // 与主题入口相同：PUSH 一条同一地址的新记录，属于新的列表访问。
  layout.scrollTo.mockClear();
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  expect(await screen.findByText('归档正文 1')).toBeTruthy();
  expect(screen.getAllByRole('article')).toHaveLength(10);
  await waitFor(() => expect(layout?.scrollY()).toBe(0));

  // 新访问再进详情并返回，仍是新访问自己的 10 条，不覆盖旧访问。
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await screen.findByRole('heading', { name: '动态详情' });
  await router.back();
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  expect(screen.getAllByRole('article')).toHaveLength(10);

  // 继续后退回到第一次访问，仍保留它的 20 条与位置。
  await router.back();
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await router.back();
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  expect(screen.getAllByRole('article')).toHaveLength(20);
  await waitFor(() => expect(layout?.scrollY()).toBe(700));
});

it('主动再次进入同一动态走新访问并从顶部开始，不沿用旧位置', async () => {
  layout = installFakeLayout();
  const { reader } = archiveTransport({ total: 10 });
  const router = await show(reader);
  await screen.findByText('归档正文 1');

  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  layout.setScrollY(500);
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));

  layout.scrollTo.mockClear();
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await waitFor(() => expect(layout?.scrollY()).toBe(0));
});

it('详情直达、刷新后重新读取，没有列表来源时返回首页', async () => {
  layout = installFakeLayout();
  const { reader, urls } = archiveTransport({ total: 3, detailIds: ['1001'] });
  const router = await show(reader, '/dynamics/1001');
  expect(await screen.findByText('归档正文 1')).toBeTruthy();
  expect(urls.filter(url => url === '/api/archive/dynamics/1001')).toHaveLength(1);

  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  expect(await screen.findByText('归档正文 1')).toBeTruthy();
});

it('不存在的动态与请求失败分别表达，失败可重试且不泄露原始错误', async () => {
  layout = installFakeLayout();
  const missing = archiveTransport({ total: 1 });
  const missingRouter = await show(missing.reader, '/dynamics/1009');
  expect(await screen.findByText('动态不存在或不可用')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(missingRouter.currentRoute.value.name).toBe('list'));

  cleanup();
  let attempts = 0;
  const failedFirst = createArchiveReader(async url => {
    if (url === '/api/archive/ups') return Response.json({ ups: [] });
    if (url === '/api/archive/dynamics/1001') {
      attempts += 1;
      if (attempts === 1) throw new Error('SECRET_TOKEN');
      return Response.json(archiveDynamic(1));
    }
    return Response.json({ items: [], next_cursor: null });
  });
  await show(failedFirst, '/dynamics/1001');
  expect((await screen.findByRole('alert')).textContent).toBe('动态详情读取失败，请重试。');
  expect(document.body.textContent).not.toContain('SECRET_TOKEN');
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('归档正文 1')).toBeTruthy();
});

it('详情读取失败可重试，取消不冒充失败', async () => {
  layout = installFakeLayout();
  let attempts = 0;
  const reader = createReader({
    readDetail: async () => {
      attempts += 1;
      return attempts === 1 ? { status: 'error' } : { status: 'cancelled' };
    },
  });
  await show(reader, '/dynamics/1001');
  expect((await screen.findByRole('alert')).textContent).toBe('动态详情读取失败，请重试。');
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('读取已取消，可重新读取。')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('详情安全展示正文、北京时间与来源计数，不显示编辑时间', async () => {
  layout = installFakeLayout();
  const text = '第一行\n🙂 https://example.test #话题#\n<script>window.pwned = true</script>\n<img src=x onerror=alert(1)>\n第四行';
  const reader = createArchiveReader(async url => url === '/api/archive/ups'
    ? Response.json({ ups: [] })
    : Response.json(archiveDynamic(1, {
      text,
      title: '标题 <b>不作为节点</b>',
      source_comment_count: 0,
    })));
  await show(reader, '/dynamics/1001');
  const detail = await screen.findByRole('article');
  expect(detail.textContent).toContain('第一行');
  expect(detail.textContent).toContain('<script>window.pwned = true</script>');
  expect(detail.textContent).toContain('标题 <b>不作为节点</b>');
  expect(document.querySelector('article script')).toBeNull();
  expect(document.querySelector('article img[src="x"]')).toBeNull();
  expect(within(detail).getByText('2026-03-01 10:03:04')).toBeTruthy();
  expect(within(detail).queryByRole('button', { name: /评论/ })).toBeNull();
  expect(detail.textContent).not.toContain('编辑');
  expect(detail.textContent).not.toContain('2026-03-02 13:01');
});

it('离开未完成的追加读取再返回，从原 cursor 继续且不遗留永久加载态', async () => {
  layout = installFakeLayout();
  const pending = deferred<ReadResult<DynamicBatch>>();
  let appendAttempts = 0;
  const user = { id: '123', nickname: '归档作者', avatarUrl: null };
  const reader = createReader({
    readUps: async () => ({ status: 'success', data: [user] }),
    readList: async input => {
      if (!input.cursor) {
        return { status: 'success', data: { items: Array.from({ length: 10 }, (_value, index) => ({
          id: String(1001 + index), author: user, publishedAt: null, text: `归档正文 ${index + 1}`, commentCount: 0,
        })), nextCursor: 'next' } };
      }
      appendAttempts += 1;
      if (appendAttempts === 1) return pending.promise;
      return { status: 'success', data: { items: Array.from({ length: 10 }, (_value, index) => ({
        id: String(1011 + index), author: user, publishedAt: null, text: `归档正文 ${index + 11}`, commentCount: 0,
      })), nextCursor: null } };
    },
    readDetail: async () => ({ status: 'success', data: {
      id: '1001', author: user, publishedAt: null, text: '详情正文', commentCount: 0,
    } }),
  });
  const router = await show(reader);
  await screen.findByText('归档正文 1');
  await fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  await screen.findByText('详情正文');
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  expect(await screen.findByText('归档正文 20')).toBeTruthy();
  expect(appendAttempts).toBe(2);
  expect(screen.queryByText('动态追加加载中…')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('旧访问的迟到详情成功/失败不覆盖新访问', async () => {
  layout = installFakeLayout();
  const first = deferred<DetailResult>();
  const second = deferred<DetailResult>();
  let calls = 0;
  const user = { id: '123', nickname: '归档作者', avatarUrl: null };
  const reader = createReader({
    readUps: async () => ({ status: 'success', data: [user] }),
    readList: async () => ({ status: 'success', data: { items: [
      { id: '1001', author: user, publishedAt: null, text: '归档正文', commentCount: 0 },
    ], nextCursor: null } }),
    readDetail: async () => {
      calls += 1;
      return (calls === 1 ? first : second).promise;
    },
  });
  const router = await show(reader);
  await screen.findByText('归档正文');
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  expect(await screen.findByText('动态详情加载中…')).toBeTruthy();
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  await fireEvent.click(await screen.findByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  expect(await screen.findByText('动态详情加载中…')).toBeTruthy();

  first.resolve({ status: 'success', data: {
    id: '1001', author: user, publishedAt: null, text: '旧访问正文', commentCount: 0,
  } });
  await Promise.resolve();
  expect(screen.queryByText('旧访问正文')).toBeNull();
  expect(screen.getByText('动态详情加载中…')).toBeTruthy();

  second.resolve({ status: 'success', data: {
    id: '1001', author: user, publishedAt: null, text: '新访问正文', commentCount: 0,
  } });
  expect(await screen.findByText('新访问正文')).toBeTruthy();
  expect(screen.queryByText('旧访问正文')).toBeNull();
});

function detailReader(overrides: Record<string, unknown>) {
  return createArchiveReader(async url => {
    if (url === '/api/archive/ups') return Response.json({ ups: [] });
    if (url.startsWith('/api/archive/dynamics/')) return Response.json(archiveDynamic(1, overrides));
    return Response.json({ items: [], next_cursor: null });
  });
}

it('详情展示完整图片组，点击任意缩略图按所点索引打开预览', async () => {
  const router = await show(detailReader({ text: '图文动态', media: archiveMedia('1001', 12) }), '/dynamics/1001');
  const detail = await screen.findByRole('article');
  const tiles = within(detail).getAllByRole('button', { name: /^预览动态图片 / });
  // 详情不裁到列表的九张，完整组按数据顺序可达。
  expect(tiles).toHaveLength(12);
  expect(tiles.map(tile => tile.getAttribute('aria-label'))[10]).toBe('预览动态图片 11');

  await fireEvent.click(tiles[10]!);
  await waitFor(() => expect(screen.getByTestId('preview-session').textContent).toBe('dynamic-1001:10/12'));
  expect(router.currentRoute.value.name).toBe('detail');
});

it('纯图动态仍展示图片，不显示“暂无内容”伪装空正文', async () => {
  await show(detailReader({ text: '', media: archiveMedia('1001', 1) }), '/dynamics/1001');
  const detail = await screen.findByRole('article');
  expect(within(detail).getAllByRole('button', { name: /^预览动态图片 / })).toHaveLength(1);
  expect(within(detail).queryByText('暂无内容')).toBeNull();
});
