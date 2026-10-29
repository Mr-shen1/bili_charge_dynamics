import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Comment, DynamicReader, Reply, ReplyBatch, ReplyLocation } from '../../src/data/contracts';
import { comment, commentDynamic } from '../fixtures/comments';
import { reply } from '../fixtures/replies';
import { createMockArchiveReader } from '../../src/mock/archiveReader';
import { createReader, deferred } from '../support/reader';
import { showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { installCompactViewport, removeCompactViewport } from '../support/viewport';

// 05：手机回复详情用与一级评论同一个单按钮切换时间/热度；排序作用于完整本地集合，
// 页码读取、失败重试与迟到响应都必须属于最后一次选择。

const dynamicId = '1001';
const rootId = comment(1).id;
const signal = () => new AbortController().signal;
// 夹具 id 9001…9025、likeCount 1…25：时间序是文件顺序，热度序是它的倒序。
const timeIds = Array.from({ length: 25 }, (_value, index) => String(9001 + index));
const hotIds = [...timeIds].reverse();
const byId = new Map<string, Reply>(timeIds.map((id, index) => [id, reply(index + 1)]));

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
  removeCompactViewport();
});

interface ReplyRequest {
  rootId: string;
  limit: number;
  page: number | undefined;
  cursor: string | null | undefined;
  sort: string | undefined;
}

function requestOf(input: {
  rootId: string; limit: number; page?: number; cursor?: string | null; sort?: string;
}): ReplyRequest {
  return { rootId: input.rootId, limit: input.limit, page: input.page, cursor: input.cursor, sort: input.sort };
}

function rootComment(overrides: Partial<Comment> = {}): Comment {
  return comment(1, { text: '被回复的根评论', replyCount: 25, ...overrides });
}

function pageBatch(ids: readonly string[], page: number): ReplyBatch {
  return {
    items: ids.slice((page - 1) * 10, page * 10).map(id => byId.get(id)!),
    nextCursor: null, count: ids.length, localReplyCount: ids.length,
    sourceReplyCount: ids.length, root: rootComment(),
  };
}

function orderOf(sort: string | undefined): readonly string[] {
  return sort === 'hot' ? hotIds : timeIds;
}

function threadReader(reader: Partial<DynamicReader>) {
  return createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    ...reader,
  });
}

function sortButton(name: string) {
  return screen.getByRole('button', { name });
}

function listedIds(): (string | undefined)[] {
  const list = screen.queryByRole('list', { name: '相关回复' });
  return list ? within(list).getAllByRole('listitem').map(item => item.dataset.readingId) : [];
}

it('手机回复详情默认按时间：页码读取显式下发 sort=time，控件只表示当前排序', async () => {
  installCompactViewport(true);
  const seen: ReplyRequest[] = [];
  const reader = threadReader({
    readReplies: async input => {
      seen.push(requestOf(input));
      return { status: 'success', data: pageBatch(orderOf(input.sort), input.page ?? 1) };
    },
  });
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);

  const button = await screen.findByRole('button', { name: '当前按时间，点击切换为按热度' });
  expect(button.textContent).toContain('☰');
  expect(button.textContent).toContain('按时间');
  expect(seen).toEqual([{ rootId, limit: 10, page: 1, cursor: undefined, sort: 'time' }]);
  // 时间序旧到新：第 1 页就是最早的一批，控件标签与数据来自同一次选择。
  expect(listedIds()).toEqual(timeIds.slice(0, 10).map(id => `reply:${rootId}:${id}`));
});

it('点击切到热度：从第 3 页回到第 1 页，按完整集合排序后的首个高赞回复出现在最前面', async () => {
  installCompactViewport(true);
  const seen: ReplyRequest[] = [];
  const reader = threadReader({
    readReplies: async input => {
      seen.push(requestOf(input));
      return { status: 'success', data: pageBatch(orderOf(input.sort), input.page ?? 1) };
    },
  });
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);

  await screen.findByRole('button', { name: '当前按时间，点击切换为按热度' });
  const pager = await screen.findByRole('navigation', { name: '回复分页' });
  await fireEvent.click(within(pager).getByRole('button', { name: '3' }));
  await waitFor(() => expect(listedIds()[0]).toBe(`reply:${rootId}:${timeIds[20]}`));
  expect(seen.at(-1)).toEqual({ rootId, limit: 10, page: 3, cursor: undefined, sort: 'time' });

  await fireEvent.click(sortButton('当前按时间，点击切换为按热度'));
  await waitFor(() => expect(screen.getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeTruthy());
  await waitFor(() => expect(listedIds()[0]).toBe(`reply:${rootId}:${hotIds[0]}`));
  // 切换后读的是目标排序的第 1 页，不沿用原页码也不拼旧批次。
  expect(seen.at(-1)).toEqual({ rootId, limit: 10, page: 1, cursor: undefined, sort: 'hot' });
  expect(listedIds()).toEqual(hotIds.slice(0, 10).map(id => `reply:${rootId}:${id}`));
  const current = screen.getByRole('navigation', { name: '回复分页' });
  expect(within(current).getByRole('button', { name: '1' }).getAttribute('aria-current')).toBe('page');
  // 同一条回复在两种排序下的位置不同：控制不住排的是完整集合，这里正是时间序第 3 页的首条。
  expect(listedIds()).toContain(`reply:${rootId}:${timeIds[24]}`);

  await fireEvent.click(sortButton('当前按热度，点击切换为按时间'));
  await waitFor(() => expect(listedIds()[0]).toBe(`reply:${rootId}:${timeIds[0]}`));
  expect(seen.at(-1)).toEqual({ rootId, limit: 10, page: 1, cursor: undefined, sort: 'time' });
});

it('快速切换只提交当前排序：旧排序迟到的成功与失败都不写入页面', async () => {
  installCompactViewport(true);
  const hotReads: { resolve: (value: Awaited<ReturnType<DynamicReader['readReplies']>>) => void }[] = [];
  const seen: ReplyRequest[] = [];
  const reader = threadReader({
    readReplies: input => {
      seen.push(requestOf(input));
      if (input.sort === 'hot') {
        const pending = deferred<Awaited<ReturnType<DynamicReader['readReplies']>>>();
        hotReads.push(pending);
        return pending.promise;
      }
      return Promise.resolve({ status: 'success' as const, data: pageBatch(timeIds, input.page ?? 1) });
    },
  });
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  await waitFor(() => expect(listedIds()).toHaveLength(10));

  await fireEvent.click(sortButton('当前按时间，点击切换为按热度'));
  // 旧排序内容不会留在“按热度”标签下：切换即清空，等待目标排序自己的数据。
  await waitFor(() => expect(listedIds()).toEqual([]));
  await fireEvent.click(sortButton('当前按热度，点击切换为按时间'));
  await waitFor(() => expect(listedIds()[0]).toBe(`reply:${rootId}:${timeIds[0]}`));

  // 迟到的热度成功与失败都不能覆盖当前选择。
  hotReads[0]!.resolve({ status: 'success', data: pageBatch(hotIds, 1) });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(listedIds()[0]).toBe(`reply:${rootId}:${timeIds[0]}`);
  expect(screen.queryByText('相关回复读取失败，请重试。')).toBeNull();
  expect(screen.getByRole('button', { name: '当前按时间，点击切换为按热度' })).toBeTruthy();
  expect(seen.at(-1)).toEqual({ rootId, limit: 10, page: 1, cursor: undefined, sort: 'time' });
});

it('目标排序读取失败仍是自己的失败：重试重发同一排序第 1 页，不拿时间序冒充', async () => {
  installCompactViewport(true);
  let hotReads = 0;
  const seen: ReplyRequest[] = [];
  const reader = threadReader({
    readReplies: async input => {
      seen.push(requestOf(input));
      if (input.sort === 'hot') {
        hotReads += 1;
        return hotReads === 1
          ? { status: 'error' as const }
          : { status: 'success' as const, data: pageBatch(hotIds, input.page ?? 1) };
      }
      return { status: 'success' as const, data: pageBatch(timeIds, input.page ?? 1) };
    },
  });
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  await waitFor(() => expect(listedIds()).toHaveLength(10));

  await fireEvent.click(sortButton('当前按时间，点击切换为按热度'));
  await waitFor(() => expect(screen.getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeTruthy());
  // 失败后页面是空的目标排序，而不是旧时间序第 1 页。
  expect(await screen.findByText('相关回复读取失败，请重试。')).toBeTruthy();
  expect(listedIds()).toEqual([]);

  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(listedIds()[0]).toBe(`reply:${rootId}:${hotIds[0]}`));
  expect(seen.at(-1)).toEqual({ rootId, limit: 10, page: 1, cursor: undefined, sort: 'hot' });
});

it('通知定位页保持时间序；切到热度读第 1 页且不再把入口回复当成该次定位', async () => {
  installCompactViewport(true);
  const locatedId = timeIds[24]!;
  const seen: ReplyRequest[] = [];
  const locates: string[] = [];
  const reader = threadReader({
    readReplies: async input => {
      seen.push(requestOf(input));
      return { status: 'success' as const, data: pageBatch(orderOf(input.sort), input.page ?? 1) };
    },
    locateReply: async input => {
      locates.push(input.replyId);
      const data: ReplyLocation = { ...pageBatch(timeIds, 3), page: 3 };
      return { status: 'success' as const, data };
    },
  });
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}/replies/${locatedId}/locate`);

  // 主动直达仍是时间序第 3 页，控件显示“按时间”。
  await screen.findByRole('button', { name: '当前按时间，点击切换为按热度' });
  await waitFor(() => expect(listedIds()).toContain(`reply:${rootId}:${locatedId}`));
  expect(document.querySelector('[data-located="true"]')?.getAttribute('data-reading-id'))
    .toBe(`reply:${rootId}:${locatedId}`);
  expect(locates).toEqual([locatedId]);

  await fireEvent.click(sortButton('当前按时间，点击切换为按热度'));
  await waitFor(() => expect(seen.at(-1)).toEqual({
    rootId, limit: 10, page: 1, cursor: undefined, sort: 'hot',
  }));
  // 热度页里恰好也有这条（点赞最高）：它不是这次定位的结果，不再标成定位目标。
  await waitFor(() => expect(listedIds()[0]).toBe(`reply:${rootId}:${locatedId}`));
  expect(document.querySelector('[data-located="true"]')).toBeNull();
  expect(locates).toEqual([locatedId]);
});

it('mock 装配使用同一排序语义：热度按点赞降序、缺失点赞后置', async () => {
  const reader = createMockArchiveReader();
  const list = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: signal() });
  if (list.status !== 'success') throw new Error('mock 列表应成功');
  const dynamic = list.data.items[0]!;
  const comments = await reader.readComments({ dynamicId: dynamic.id, sort: 'latest', signal: signal() });
  if (comments.status !== 'success') throw new Error('mock 评论应成功');
  const root = comments.data.items[0]!;
  const page = async (sort: 'time' | 'hot', number: number): Promise<ReplyBatch> => {
    const result = await reader.readReplies({
      dynamicId: dynamic.id, rootId: root.id, page: number, limit: 10, sort, signal: signal(),
    });
    if (result.status !== 'success') throw new Error(`mock 页码 ${number} 应成功`);
    return result.data;
  };
  const pages = [1, 2, 3];
  const time = (await Promise.all(pages.map(number => page('time', number))))
    .flatMap(batch => batch.items);
  const hot = (await Promise.all(pages.map(number => page('hot', number))))
    .flatMap(batch => batch.items);
  expect(new Set(hot.map(item => item.id))).toEqual(new Set(time.map(item => item.id)));
  const likes = hot.map(item => item.likeCount);
  const ranked = [...likes].sort((a, b) => (b ?? Number.NEGATIVE_INFINITY) - (a ?? Number.NEGATIVE_INFINITY));
  expect(likes).toEqual(ranked);
  // mock 夹具的点赞随序号递增，因此热度第一条就是时间序的最后一条。
  expect(hot[0]!.id).toBe(time.at(-2)!.id);
  expect(hot.at(-1)!.likeCount).toBeNull();
});
