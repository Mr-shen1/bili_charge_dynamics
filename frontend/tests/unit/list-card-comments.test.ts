import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createArchiveReader } from '../../src/data/archiveReader';
import type { ArchiveNavigation } from '../../src/app/navigation';
import { archiveComment } from '../fixtures/comments';
import { archiveReply } from '../fixtures/replies';
import { archiveDynamic, archiveUser } from '../fixtures/archive';
import { settle, showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { installCompactViewport, removeCompactViewport } from '../support/viewport';

// 桌面卡片内联评论：点击卡片评论按钮在卡片下方展开完整一级评论阅读区，
// 列表与 URL 都不跳走；多张卡片的排序、批次与回复页码各自独立。
// 读取经由生产 Adapter 的 DTO 映射，请求参数（sort/cursor/page）可直接观察。

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
  removeCompactViewport();
});

interface CommentRequest {
  dynamicId: string;
  sort: string | null;
  cursor: string | null;
}

function dynamic(index: number) {
  return archiveDynamic(index, {
    source_comment_count: 5 + index,
    local_comment_count: 5 + index,
    text: `动态正文 ${index}`,
  });
}

/** 列表两条动态 + 每张卡片的评论与回复读取；请求按动态分开计数，便于断言隔离。 */
function cardTransport(options: {
  delays?: (request: CommentRequest) => number;
  fail?: (request: CommentRequest) => boolean;
} = {}) {
  const commentRequests: CommentRequest[] = [];
  const replyRequests: { dynamicId: string; rootId: string; page: string | null; cursor: string | null }[] = [];
  const reader = createArchiveReader(async url => {
    if (url === '/api/archive/ups') return Response.json({ ups: [archiveUser('123', '归档作者')] });
    const comments = /^\/api\/archive\/dynamics\/([^/?]+)\/comments\?/.exec(url);
    if (comments) {
      const parsed = new URL(url, 'http://local');
      const dynamicId = comments[1]!;
      const request: CommentRequest = {
        dynamicId,
        sort: parsed.searchParams.get('sort'),
        cursor: parsed.searchParams.get('cursor'),
      };
      commentRequests.push(request);
      const delay = options.delays?.(request) ?? 0;
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      if (options.fail?.(request)) return Response.json({ error: { code: 'INTERNAL' } }, { status: 500 });
      const offset = request.cursor === null ? 0 : Number(request.cursor.split(':').at(-1));
      const items = Array.from({ length: 2 }, (_value, index) => archiveComment(
        Number(dynamicId.slice(3)) * 10 + offset + index + 1,
        {
          dynamic_id: dynamicId,
          text: `${dynamicId}/${request.sort} 评论 ${offset + index + 1}`,
          source_reply_count: 25,
        },
      ));
      return Response.json({ items, next_cursor: offset + 2 < 4 ? `${request.sort}:${offset + 2}` : null });
    }
    const replies = /^\/api\/archive\/dynamics\/([^/?]+)\/comments\/([^/?]+)\/replies\?/.exec(url);
    if (replies) {
      const parsed = new URL(url, 'http://local');
      const dynamicId = replies[1]!;
      const rootId = replies[2]!;
      const page = parsed.searchParams.get('page');
      const cursor = parsed.searchParams.get('cursor');
      replyRequests.push({ dynamicId, rootId, page, cursor });
      const root = archiveComment(1, { dynamic_id: dynamicId, id: rootId, source_reply_count: 25 });
      if (page === null) {
        const items = Array.from({ length: 3 }, (_value, index) => archiveReply(index + 1, {
          dynamic_id: dynamicId, root_id: rootId, parent_id: rootId,
          text: `${rootId} 的第 ${index + 1} 条回复`,
        }));
        return Response.json({ items, next_cursor: `${rootId}:3`, root });
      }
      const start = (Number(page) - 1) * 10;
      const items = Array.from({ length: 10 }, (_value, index) => archiveReply(start + index + 1, {
        dynamic_id: dynamicId, root_id: rootId, parent_id: rootId,
        text: `${rootId} 的第 ${start + index + 1} 条回复`,
      }));
      return Response.json({
        items, next_cursor: null, root, count: 25, local_reply_count: 25, source_reply_count: 25,
      });
    }
    const detail = /^\/api\/archive\/dynamics\/([^/?]+)$/.exec(url);
    if (detail) return Response.json(dynamic(Number(detail[1]!.slice(3))));
    const list = /^\/api\/archive\/dynamics\?/.exec(url);
    if (list) return Response.json({ items: [dynamic(1), dynamic(2)], next_cursor: null });
    return Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 });
  });
  return { reader, commentRequests, replyRequests };
}

function card(index: number): HTMLElement {
  return screen.getAllByRole('article')[index]!;
}

it('宽屏点击卡片评论按钮在卡片下方展开评论，列表与 URL 不跳走；再次点击收起', async () => {
  const { reader, commentRequests } = cardTransport();
  const router = await showApp(reader);
  await screen.findByText('动态正文 1');

  const entry = within(card(0)).getByRole('button', { name: '来源评论 6' });
  await fireEvent.click(entry);

  const region = await screen.findByRole('region', { name: '评论区' });
  expect(within(card(0)).getByRole('region', { name: '评论区' })).toBe(region);
  expect(router.currentRoute.value.path).toBe('/');
  expect(await within(region).findByText('1001/latest 评论 1')).toBeTruthy();
  expect(commentRequests).toEqual([{ dynamicId: '1001', sort: 'latest', cursor: null }]);
  // 另一张卡片没有被顺手展开，也没有发它的评论请求。
  expect(within(card(1)).queryByRole('region', { name: '评论区' })).toBeNull();

  await fireEvent.click(entry);
  expect(screen.queryByRole('region', { name: '评论区' })).toBeNull();
  expect(document.activeElement).toBe(entry);
  expect(router.currentRoute.value.path).toBe('/');
});

it('两张卡片同时展开时排序、批次与回复页码各自独立', async () => {
  const { reader, commentRequests, replyRequests } = cardTransport();
  const router = await showApp(reader);
  await screen.findByText('动态正文 1');

  await fireEvent.click(within(card(0)).getByRole('button', { name: '来源评论 6' }));
  await fireEvent.click(within(card(1)).getByRole('button', { name: '来源评论 7' }));
  const first = within(card(0)).getByRole('region', { name: '评论区' });
  const second = within(card(1)).getByRole('region', { name: '评论区' });
  expect(await within(first).findByText('1001/latest 评论 1')).toBeTruthy();
  expect(await within(second).findByText('1002/latest 评论 1')).toBeTruthy();
  expect(await within(second).findByText('1002/latest 评论 2')).toBeTruthy();

  // 只切换第一张卡片的排序：第二张仍按时间，自己的批次不被重置。
  await fireEvent.click(within(first).getByRole('button', { name: '当前按时间，点击切换为按热度' }));
  expect(await within(first).findByText('1001/hot 评论 1')).toBeTruthy();
  expect(within(second).getByRole('button', { name: '当前按时间，点击切换为按热度' })).toBeTruthy();
  expect(within(second).getByText('1002/latest 评论 1')).toBeTruthy();

  // 第一张追加下一批，第二张不跟着追加。
  await fireEvent.click(within(first).getByRole('button', { name: '加载更多评论' }));
  expect(await within(first).findByText('1001/hot 评论 3')).toBeTruthy();
  expect(within(second).queryByText('1002/latest 评论 3')).toBeNull();

  // 回复页码：只有第一张卡片的楼中楼展开并读第 1 页，第二张保持 3 条预览。
  const root = within(first).getAllByRole('listitem')[0]!;
  await fireEvent.click(within(root).getByRole('button', { name: '展开回复' }));
  const replyList = await within(root).findByRole('list', { name: '回复列表' });
  expect(within(replyList).getByText('5011 的第 1 条回复')).toBeTruthy();
  expect(within(second).queryAllByRole('navigation', { name: '回复分页' })).toHaveLength(0);

  expect(commentRequests).toEqual([
    { dynamicId: '1001', sort: 'latest', cursor: null },
    { dynamicId: '1002', sort: 'latest', cursor: null },
    { dynamicId: '1001', sort: 'hot', cursor: null },
    { dynamicId: '1001', sort: 'hot', cursor: 'hot:2' },
  ]);
  expect(replyRequests.filter(request => request.page !== null)).toEqual([
    { dynamicId: '1001', rootId: '5011', page: '1', cursor: null },
  ]);
  expect(router.currentRoute.value.path).toBe('/');
});

it('窄屏保持既有入口：点击卡片评论进入详情评论区，列表里不出现一套内联评论', async () => {
  installCompactViewport(true);
  const { reader, commentRequests } = cardTransport();
  const router = await showApp(reader);
  await screen.findByText('动态正文 1');
  expect(screen.queryByRole('region', { name: '评论区' })).toBeNull();

  await fireEvent.click(within(card(0)).getByRole('button', { name: '来源评论 6' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  expect(router.currentRoute.value.fullPath).toBe('/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  expect(await within(region).findByText('1001/latest 评论 1')).toBeTruthy();
  expect(commentRequests).toEqual([{ dynamicId: '1001', sort: 'latest', cursor: null }]);

  // 返回列表仍是窄屏入口：没有任何卡片评论面板在列表里展开着。
  await router.go(-1);
  console.log('B1', router.currentRoute.value.path, JSON.stringify(router.options.history.state));
  await settle();
  console.log('B2', JSON.stringify(router.options.history.state));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  expect(await screen.findByText('动态正文 1')).toBeTruthy();
  expect(screen.queryByRole('region', { name: '评论区' })).toBeNull();
});

it('离开列表再返回，各卡片按所属访问恢复自己的展开、排序与批次，不重复请求', async () => {
  const { reader, commentRequests } = cardTransport();
  let navigation: ArchiveNavigation | null = null;
  const router = await showApp(reader, '/', undefined, undefined, value => { navigation = value; });
  await screen.findByText('动态正文 1');

  await fireEvent.click(within(card(0)).getByRole('button', { name: '来源评论 6' }));
  await fireEvent.click(within(card(1)).getByRole('button', { name: '来源评论 7' }));
  const first = within(card(0)).getByRole('region', { name: '评论区' });
  await fireEvent.click(within(first).getByRole('button', { name: '当前按时间，点击切换为按热度' }));
  expect(await within(first).findByText('1001/hot 评论 1')).toBeTruthy();
  await fireEvent.click(within(first).getByRole('button', { name: '加载更多评论' }));
  expect(await within(first).findByText('1001/hot 评论 3')).toBeTruthy();
  expect(await within(card(1)).findByText('1002/latest 评论 2')).toBeTruthy();

  // 进入详情再返回：列表访问快照按卡片保存展开、排序与已读批次。
  // 宽屏正文入口另开标签（不改本标签历史），所以这里走应用自己的导航入口离开列表。
  navigation!.openDetail('1001');
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const before = commentRequests.length;
  await settle();
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));

  const restoredFirst = within(card(0)).getByRole('region', { name: '评论区' });
  const restoredSecond = within(card(1)).getByRole('region', { name: '评论区' });
  expect(within(restoredFirst).getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeTruthy();
  expect(within(restoredFirst).getByText('1001/hot 评论 3')).toBeTruthy();
  expect(within(restoredSecond).getByRole('button', { name: '当前按时间，点击切换为按热度' })).toBeTruthy();
  expect(within(restoredSecond).getByText('1002/latest 评论 2')).toBeTruthy();
  // 恢复已读批次不再重复请求；详情页的读取属于它自己的区域。
  expect(commentRequests.slice(before)).toEqual([{ dynamicId: '1001', sort: 'latest', cursor: null }]);
});

it('一张卡片读取失败只在自己区域提示，不清空列表或另一张卡片', async () => {
  let failing = true;
  const { reader } = cardTransport({ fail: request => failing && request.dynamicId === '1002' });
  const router = await showApp(reader);
  await screen.findByText('动态正文 1');

  await fireEvent.click(within(card(0)).getByRole('button', { name: '来源评论 6' }));
  const first = within(card(0)).getByRole('region', { name: '评论区' });
  expect(await within(first).findByText('1001/latest 评论 1')).toBeTruthy();

  await fireEvent.click(within(card(1)).getByRole('button', { name: '来源评论 7' }));
  const second = within(card(1)).getByRole('region', { name: '评论区' });
  expect((await within(second).findByRole('alert')).textContent).toBe('最新评论读取失败，请重试。');
  // 失败不外溢：列表仍在、另一张卡片的评论与读取都没被清空。
  expect(screen.getAllByRole('article')).toHaveLength(2);
  expect(within(first).getByText('1001/latest 评论 1')).toBeTruthy();
  expect(router.currentRoute.value.path).toBe('/');
  // 局部重试只重读这一张卡片。
  failing = false;
  await fireEvent.click(within(second).getByRole('button', { name: '重试' }));
  expect(await within(second).findByText('1002/latest 评论 1')).toBeTruthy();
  expect(within(second).queryAllByRole('alert')).toHaveLength(0);
});

it('评论正文与分页点击不触发动态正文导航，文本选择也不跳详情', async () => {
  const { reader } = cardTransport();
  const router = await showApp(reader);
  await screen.findByText('动态正文 1');
  await fireEvent.click(within(card(0)).getByRole('button', { name: '来源评论 6' }));
  const region = within(card(0)).getByRole('region', { name: '评论区' });
  const text = await within(region).findByText('1001/latest 评论 1');

  await fireEvent.click(text);
  await fireEvent.click(within(region).getByRole('heading', { level: 2 }));
  expect(router.currentRoute.value.path).toBe('/');
  // 正文折叠入口同样是内部操作。
  const toggle = within(region).queryByRole('button', { name: '展开评论' });
  if (toggle) {
    await fireEvent.click(toggle);
    expect(router.currentRoute.value.path).toBe('/');
  }
  expect(within(card(0)).getByRole('region', { name: '评论区' })).toBeTruthy();
});

it('收起卡片后迟到的评论响应不再显示，也不打断另一张卡片', async () => {
  const { reader, commentRequests } = cardTransport({
    delays: request => request.dynamicId === '1001' ? 80 : 0,
  });
  const router = await showApp(reader);
  await screen.findByText('动态正文 1');

  const entry = within(card(0)).getByRole('button', { name: '来源评论 6' });
  await fireEvent.click(entry);
  await fireEvent.click(entry);
  expect(screen.queryByRole('region', { name: '评论区' })).toBeNull();

  // 另一张卡片在此期间正常展开并读到自己的批次。
  await fireEvent.click(within(card(1)).getByRole('button', { name: '来源评论 7' }));
  const second = within(card(1)).getByRole('region', { name: '评论区' });
  expect(await within(second).findByText('1002/latest 评论 1')).toBeTruthy();

  await new Promise(resolve => setTimeout(resolve, 200));
  // 迟到的旧响应没有让已收起的区域复活，也没有把别的卡片内容改成自己的。
  expect(within(card(0)).queryByRole('region', { name: '评论区' })).toBeNull();
  expect(within(second).getByText('1002/latest 评论 1')).toBeTruthy();
  expect(router.currentRoute.value.path).toBe('/');

  // 再次展开是同一面板：从自己的状态继续，而不是把旧结果当新结果。
  await fireEvent.click(entry);
  expect(await within(card(0)).findByText('1001/latest 评论 1')).toBeTruthy();
  expect(commentRequests.filter(request => request.dynamicId === '1001')).toHaveLength(2);
});

it('切换 scope 后不继承列表访问的卡片状态，返回原 scope 时按所属访问恢复', async () => {
  const { reader, commentRequests } = cardTransport();
  const router = await showApp(reader);
  await screen.findByText('动态正文 1');
  // 首次访问的历史标记补写先落盘，离开再返回才是同一次列表访问。
  await settle();
  await fireEvent.click(within(card(1)).getByRole('button', { name: '来源评论 7' }));
  expect(await within(card(1)).findByText('1002/latest 评论 1')).toBeTruthy();

  // 用户路径：UP 条切到单 UP scope。
  await fireEvent.click(await screen.findByRole('link', { name: '归档作者' }));
  await waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/ups/123'));
  await screen.findByText('动态正文 1');
  expect(screen.queryByRole('region', { name: '评论区' })).toBeNull();
  await fireEvent.click(within(card(0)).getByRole('button', { name: '来源评论 6' }));
  expect(await within(card(0)).findByText('1001/latest 评论 1')).toBeTruthy();

  const before = commentRequests.length;
  await settle();
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/'));
  expect(await screen.findByText('动态正文 1')).toBeTruthy();
  // 原访问的卡片状态恢复；新访问里展开的 1001 不带回来。
  expect(within(card(1)).getByRole('region', { name: '评论区' })).toBeTruthy();
  expect(within(card(0)).queryByRole('region', { name: '评论区' })).toBeNull();
  expect(commentRequests).toHaveLength(before);
});
