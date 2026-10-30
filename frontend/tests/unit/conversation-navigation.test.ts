import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Comment, ConversationResult, Reply, ReplyBatch, ReplySort } from '../../src/data/contracts';
import { comment, commentDynamic } from '../fixtures/comments';
import { reply, replies } from '../fixtures/replies';
import type { DynamicReader } from '../../src/data/contracts';
import { createReader, deferred } from '../support/reader';
import { settle, showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { installCompactViewport, removeCompactViewport } from '../support/viewport';

// 07：会话往返恢复。回复访问（独立楼中楼页与窄屏回复精确入口）是会话的来源：
// 返回时恢复那一次访问的排序、页码、位置与内容；无有效来源时替换为所属回复详情的时间序第 1 页。
// 会话身份是动态 + 根评论 + 入口回复，不以页码或昵称充当身份，也不与应用会话状态混用。

const dynamicId = '1001';
const rootId = comment(1).id;

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
  removeCompactViewport();
});

interface ReplyRead {
  readonly page: number;
  readonly sort: ReplySort | undefined;
}

function rootComment(): Comment {
  return comment(1, { text: '被回复的根评论', replyCount: 25 });
}

/** 时间序是夹具原顺序，热度是倒序：两条排序的同一页内容因此可以逐条区分。 */
function ordered(sort: ReplySort): Reply[] {
  const all = replies(25);
  return sort === 'hot' ? [...all].reverse() : all;
}

function pageBatch(sort: ReplySort, page: number): ReplyBatch {
  const offset = (page - 1) * 10;
  return {
    items: ordered(sort).slice(offset, offset + 10),
    nextCursor: null,
    count: 25,
    localReplyCount: 25,
    sourceReplyCount: 25,
    root: rootComment(),
  };
}

/** 第 2 页首条进入一段以时间序第 1 条为起点的对话：入口资格与当前页/排序无关。 */
function withConversation(page: number, batch: ReplyBatch): ReplyBatch {
  if (page !== 2) return batch;
  const startId = ordered('time')[0]!.id;
  return {
    ...batch,
    items: batch.items.map((item, index) => (index === 0
      ? { ...item, conversation: { startId, count: 2, incomplete: false } }
      : item)),
  };
}

function readingId(item: Reply): string {
  return `reply:${rootId}:${item.id}`;
}

/** 回复列表会随排序切换重建 DOM，每次断言都重新取当前列表。 */
function replyList(): HTMLElement {
  return screen.getByRole('list', { name: '相关回复' });
}

/** 当前列表里某条回复的 DOM 节点；恢复后要按业务标识核对具体条目。 */
function entryOf(item: Reply): HTMLElement {
  return replyList().querySelector<HTMLElement>(`[data-reading-id="${readingId(item)}"]`)!;
}

function firstReadingId(): string | undefined {
  return within(replyList()).getAllByRole('listitem')[0]!.dataset.readingId;
}

it('热度第 2 页进入会话再返回：恢复该次访问的排序、页码与位置，不重读第 1 页', async () => {
  installCompactViewport(true);
  const reads: ReplyRead[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => {
      reads.push({ page: input.page ?? 0, sort: input.sort });
      const sort: ReplySort = input.sort ?? 'time';
      const page = input.page ?? 1;
      return { status: 'success', data: withConversation(page, pageBatch(sort, page)) };
    },
    readConversation: async input => ({
      status: 'success',
      data: {
        dynamicId, rootId, replyId: input.replyId, startId: ordered('time')[0]!.id,
        incomplete: false, count: 2, nextCursor: null,
        items: ordered('time').slice(0, 2),
      },
    }),
  });

  const router = await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  const list = await screen.findByRole('list', { name: '相关回复' });
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(10));
  expect(reads).toEqual([{ page: 1, sort: 'time' }]);

  // 切到热度并读到第 2 页：这是本次回复访问的状态。
  await fireEvent.click(screen.getByRole('button', { name: '当前按时间，点击切换为按热度' }));
  await waitFor(() => expect(reads.at(-1)).toEqual({ page: 1, sort: 'hot' }));
  await waitFor(() => expect(firstReadingId()).toBe(readingId(ordered('hot')[0]!)));
  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(reads.at(-1)).toEqual({ page: 2, sort: 'hot' }));
  await waitFor(() => expect(firstReadingId()).toBe(readingId(ordered('hot')[10]!)));
  layout.setScrollY(700);
  await settle();

  await fireEvent.click(within(replyList()).getAllByRole('button', { name: '查看对话' })[0]!);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
  expect(await screen.findByRole('list', { name: '对话内容' })).toBeTruthy();
  const readsBeforeBack = reads.length;

  await fireEvent.click(screen.getByRole('button', { name: '会话列表，返回评论详情' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));

  // 先看到的就是第 2 页热度内容：不是先显示第 1 页再纠正。
  expect(await screen.findByRole('list', { name: '相关回复' })).toBeTruthy();
  expect(firstReadingId()).toBe(readingId(ordered('hot')[10]!));
  expect(screen.getByRole('button', { name: '当前按热度，点击切换为按时间' })).toBeTruthy();
  const pager = screen.getByRole('navigation', { name: '回复分页' });
  expect(within(pager).getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');
  // 不重读第 1 页，也不用时间序定位覆盖这次热度访问。
  expect(reads.length).toBe(readsBeforeBack);
  await waitFor(() => expect(layout.scrollY()).toBe(700));
});

/** jsdom 没有 scrollIntoView：记录被主动定位的元素，用来证明恢复不重复定位。 */
function recordScrollIntoView(): Element[] {
  const scrolled: Element[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: Element) { scrolled.push(this); },
  });
  return scrolled;
}

it('通知定位页进入会话再返回：恢复该次定位访问的时间序页码、锚点与位置，不重复定位', async () => {
  installCompactViewport(true);
  const scrolled = recordScrollIntoView();
  const target = ordered('time')[13]!;
  const located: string[] = [];
  const reads: ReplyRead[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => {
      reads.push({ page: input.page ?? 0, sort: input.sort });
      return { status: 'success', data: pageBatch('time', input.page ?? 1) };
    },
    locateReply: async input => {
      located.push(input.replyId);
      const batch = pageBatch('time', 2);
      return {
        status: 'success',
        data: {
          ...batch,
          page: 2,
          items: batch.items.map(item => (item.id === input.replyId
            ? { ...item, conversation: { startId: ordered('time')[0]!.id, count: 2, incomplete: false } }
            : item)),
        },
      };
    },
    readConversation: async input => ({
      status: 'success',
      data: {
        dynamicId, rootId, replyId: input.replyId, startId: ordered('time')[0]!.id,
        incomplete: false, count: 2, nextCursor: null,
        items: ordered('time').slice(0, 2),
      },
    }),
  });

  const locatePath = `/dynamics/${dynamicId}/comments/${rootId}/replies/${target.id}/locate`;
  const router = await showApp(reader, locatePath);
  await waitFor(() => expect(within(replyList()).getAllByRole('listitem')).toHaveLength(10));
  // 首个读取是定位读取：不先读第 1 页。
  expect(located).toEqual([target.id]);
  expect(reads).toEqual([]);
  expect(within(screen.getByRole('navigation', { name: '回复分页' }))
    .getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');
  layout.setScrollY(900);
  await settle();
  const locatesBefore = scrolled.length;

  const entry = entryOf(target);
  await fireEvent.click(within(entry).getByRole('button', { name: '查看对话' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
  expect(await screen.findByRole('list', { name: '对话内容' })).toBeTruthy();

  await fireEvent.click(screen.getByRole('button', { name: '会话列表，返回评论详情' }));
  await waitFor(() => expect(router.currentRoute.value.path).toBe(locatePath));

  // 恢复的是这次定位访问：时间序第 2 页、目标仍带标记、位置回来，且不再重新定位。
  expect(firstReadingId()).toBe(readingId(ordered('time')[10]!));
  expect(entryOf(target).dataset.located).toBe('true');
  expect(located).toEqual([target.id]);
  expect(reads).toEqual([]);
  expect(scrolled.length).toBe(locatesBefore);
  await waitFor(() => expect(layout.scrollY()).toBe(900));
});

it('历史前进/后退各恢复自己的访问：另一根、另一次访问的页码与位置都不串用', async () => {
  installCompactViewport(true);
  const otherRoot = { ...comment(2), id: '5002', text: '另一根评论' };
  /** 每个根有自己的回复条目，恢复时能按业务标识核对是不是同一份访问。 */
  const itemsFor = (root: string, sort: ReplySort): Reply[] => replies(25).map((item, index) =>
    ({ ...item, id: `${root.slice(-1)}-${sort === 'hot' ? 25 - index : index + 1}` }));
  const batch = (root: string, sort: ReplySort, page: number): ReplyBatch => ({
    items: itemsFor(root, sort).slice((page - 1) * 10, (page - 1) * 10 + 10),
    nextCursor: null, count: 25, localReplyCount: 25, sourceReplyCount: 25,
    root: { ...rootComment(), id: root },
  });
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => ({
      status: 'success', data: batch(input.rootId, input.sort ?? 'time', input.page ?? 1),
    }),
  });

  const firstPath = `/dynamics/${dynamicId}/comments/${rootId}`;
  const secondPath = `/dynamics/${dynamicId}/comments/${otherRoot.id}`;
  const router = await showApp(reader, firstPath);
  await waitFor(() => expect(within(replyList()).getAllByRole('listitem')).toHaveLength(10));
  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(firstReadingId()).toBe(`reply:${rootId}:${itemsFor(rootId, 'time')[10]!.id}`));
  layout.setScrollY(500);
  await settle();

  // 另一根是另一次访问：从第 1 页、页面顶部开始，不继承上一根的页码与位置。
  await router.push(secondPath);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  await waitFor(() => expect(firstReadingId()).toBe(`reply:${otherRoot.id}:${itemsFor(otherRoot.id, 'time')[0]!.id}`));
  await waitFor(() => expect(layout.scrollY()).toBe(0));
  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(firstReadingId())
    .toBe(`reply:${otherRoot.id}:${itemsFor(otherRoot.id, 'time')[10]!.id}`));
  layout.setScrollY(800);
  await settle();

  // 后退回到第一根的访问：它自己的第 2 页与位置。
  await router.go(-1);
  await waitFor(() => expect(firstReadingId()).toBe(`reply:${rootId}:${itemsFor(rootId, 'time')[10]!.id}`));
  expect(within(screen.getByRole('navigation', { name: '回复分页' }))
    .getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');
  await waitFor(() => expect(layout.scrollY()).toBe(500));

  // 前进回到另一根的访问：不串用第一根的页码与位置。
  await router.go(1);
  await waitFor(() => expect(firstReadingId())
    .toBe(`reply:${otherRoot.id}:${itemsFor(otherRoot.id, 'time')[10]!.id}`));
  await waitFor(() => expect(layout.scrollY()).toBe(800));
});

it('同一条楼中楼地址的新访问不复用上一次访问的页码与位置', async () => {
  installCompactViewport(true);
  const reads: ReplyRead[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => {
      reads.push({ page: input.page ?? 0, sort: input.sort });
      return { status: 'success', data: pageBatch(input.sort ?? 'time', input.page ?? 1) };
    },
  });

  const path = `/dynamics/${dynamicId}/comments/${rootId}`;
  const router = await showApp(reader, path);
  await waitFor(() => expect(within(replyList()).getAllByRole('listitem')).toHaveLength(10));
  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(firstReadingId()).toBe(readingId(ordered('time')[10]!)));
  layout.setScrollY(600);
  await settle();

  // 离开后按地址重新进入：这是新访问，从第 1 页与顶部开始。
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  await settle();
  await router.push(path);
  await waitFor(() => expect(firstReadingId()).toBe(readingId(ordered('time')[0]!)));
  expect(reads.at(-1)).toEqual({ page: 1, sort: 'time' });
  await waitFor(() => expect(layout.scrollY()).toBe(0));
});

it('直达会话没有来源时返回替换为所属回复详情的时间序第 1 页，历史里不留下会话地址', async () => {
  installCompactViewport(true);
  const reads: ReplyRead[] = [];
  const conversationPath = `/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(2).id}/conversation`;
  const entry = reply(2);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => {
      reads.push({ page: input.page ?? 0, sort: input.sort });
      return { status: 'success', data: pageBatch(input.sort ?? 'time', input.page ?? 1) };
    },
    readConversation: async input => ({
      status: 'success',
      data: {
        dynamicId, rootId, replyId: input.replyId, startId: entry.id,
        incomplete: false, count: 2, nextCursor: null,
        items: [entry, ordered('time')[2]!],
      },
    }),
  });

  // 复制地址直达/刷新：当前记录没有来源关系，会话仍只靠 URL 与只读接口读取。
  const router = await showApp(reader, '/');
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  await router.push(conversationPath);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
  expect(await screen.findByRole('list', { name: '对话内容' })).toBeTruthy();

  await fireEvent.click(screen.getByRole('button', { name: '会话列表，返回评论详情' }));
  await waitFor(() => expect(router.currentRoute.value.path).toBe(`/dynamics/${dynamicId}/comments/${rootId}`));
  // 无来源时是“所属回复详情的时间序第 1 页”：不退回热度页，也不留在会话地址上。
  expect(reads.at(-1)).toEqual({ page: 1, sort: 'time' });
  expect(firstReadingId()).toBe(readingId(ordered('time')[0]!));
  expect(screen.getByRole('button', { name: '当前按时间，点击切换为按热度' })).toBeTruthy();

  // 替换导航不留会话记录：历史后退回到上一页而不是又进会话。
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  expect(router.currentRoute.value.name).toBe('list');
});

it('离开时还在飞的翻页结果迟到不改写恢复后的访问', async () => {
  installCompactViewport(true);
  const pending = deferred<Awaited<ReturnType<DynamicReader['readReplies']>>>();
  const reads: ReplyRead[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => {
      reads.push({ page: input.page ?? 0, sort: input.sort });
      if (input.page === 3) return pending.promise;
      const page = input.page ?? 1;
      const sort: ReplySort = input.sort ?? 'time';
      return { status: 'success', data: withConversation(page, pageBatch(sort, page)) };
    },
    readConversation: async input => ({
      status: 'success',
      data: {
        dynamicId, rootId, replyId: input.replyId, startId: ordered('time')[0]!.id,
        incomplete: false, count: 2, nextCursor: null,
        items: ordered('time').slice(0, 2),
      },
    }),
  });

  const router = await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  await waitFor(() => expect(within(replyList()).getAllByRole('listitem')).toHaveLength(10));
  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(firstReadingId()).toBe(readingId(ordered('time')[10]!)));
  layout.setScrollY(700);
  await settle();

  // 第 3 页读取挂起时离开这一访问进入会话。
  await fireEvent.click(screen.getByRole('button', { name: '3' }));
  await waitFor(() => expect(reads.at(-1)).toEqual({ page: 3, sort: 'time' }));
  await fireEvent.click(within(entryOf(ordered('time')[10]!)).getByRole('button', { name: '查看对话' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
  await fireEvent.click(screen.getByRole('button', { name: '会话列表，返回评论详情' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  await waitFor(() => expect(reads.at(-1)).toEqual({ page: 2, sort: 'time' }));

  // 迟到的第 3 页结果属于已经离开的访问：不覆盖恢复后的第 2 页。
  pending.resolve({ status: 'success', data: pageBatch('time', 3) });
  await settle();
  expect(firstReadingId()).toBe(readingId(ordered('time')[10]!));
  expect(within(screen.getByRole('navigation', { name: '回复分页' }))
    .getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');
  await waitFor(() => expect(layout.scrollY()).toBe(700));
});

it('恢复的访问保留上次的失败与已读内容：先看到原内容，重试同一页再继续', async () => {
  installCompactViewport(true);
  let fail = true;
  const reads: ReplyRead[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => {
      reads.push({ page: input.page ?? 0, sort: input.sort });
      const page = input.page ?? 1;
      if (page === 2 && fail) return { status: 'error' };
      const sort: ReplySort = input.sort ?? 'time';
      const batch = pageBatch(sort, page);
      return {
        status: 'success',
        data: page === 1
          ? { ...batch, items: batch.items.map((item, index) => (index === 1
            ? { ...item, conversation: { startId: ordered('time')[0]!.id, count: 2, incomplete: false } }
            : item)) }
          : batch,
      };
    },
    readConversation: async input => ({
      status: 'success',
      data: {
        dynamicId, rootId, replyId: input.replyId, startId: ordered('time')[0]!.id,
        incomplete: false, count: 2, nextCursor: null,
        items: ordered('time').slice(0, 2),
      },
    }),
  });

  const router = await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  await waitFor(() => expect(within(replyList()).getAllByRole('listitem')).toHaveLength(10));
  // 第 2 页读取失败：保留第 1 页内容并给出局部重试，不把已读内容清空。
  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeTruthy());
  expect(screen.getByRole('alert')!.textContent).toBe('相关回复追加读取失败，请重试。');
  expect(within(replyList()).getAllByRole('listitem')).toHaveLength(10);

  await fireEvent.click(within(entryOf(ordered('time')[1]!)).getByRole('button', { name: '查看对话' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
  await fireEvent.click(screen.getByRole('button', { name: '会话列表，返回评论详情' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));

  // 恢复不丢内容：仍是同一页已读内容，失败提示与重试入口都还在。
  expect(firstReadingId()).toBe(readingId(ordered('time')[0]!));
  expect(screen.getByRole('alert')!.textContent).toBe('相关回复追加读取失败，请重试。');

  fail = false;
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(reads.at(-1)).toEqual({ page: 1, sort: 'time' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(within(replyList()).getAllByRole('listitem')).toHaveLength(10);
});

it('定位读取失败的访问恢复后仍按目标身份重试：不拿第 1 页冒充定位结果', async () => {
  installCompactViewport(true);
  const target = ordered('time')[13]!;
  let fail = true;
  const located: string[] = [];
  const reads: ReplyRead[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => {
      reads.push({ page: input.page ?? 0, sort: input.sort });
      return { status: 'success', data: pageBatch(input.sort ?? 'time', input.page ?? 1) };
    },
    locateReply: async input => {
      located.push(input.replyId);
      if (fail) return { status: 'error' };
      return { status: 'success', data: { ...pageBatch('time', 2), page: 2 } };
    },
  });

  const locatePath = `/dynamics/${dynamicId}/comments/${rootId}/replies/${target.id}/locate`;
  const router = await showApp(reader, locatePath);
  // 定位失败：保留失败提示与重试入口，不拿楼层开头冒充成功。
  await waitFor(() => expect(screen.queryByRole('alert')).toBeTruthy());
  expect(located).toEqual([target.id]);
  expect(reads).toEqual([]);
  // 等访问标识落盘：历史记录没有标记时，后退会被当成新访问（快照无从取回）。
  await settle();

  // 离开再回到这次访问（历史前进/后退）：失败状态与定位意图一起恢复。
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  await settle();
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.path).toBe(locatePath));
  expect(screen.getByRole('alert')!.textContent).toBe('相关回复读取失败，请重试。');
  expect(reads).toEqual([]);

  // 重试仍按目标身份重新定位，而不是读第 1 页。
  fail = false;
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(located).toEqual([target.id, target.id]));
  await waitFor(() => expect(firstReadingId()).toBe(readingId(ordered('time')[10]!)));
  expect(reads).toEqual([]);
  expect(entryOf(target).dataset.located).toBe('true');
});

it('同一会话访问返回时恢复上次阅读位置，不重复定位也不抢用户滚动', async () => {
  installCompactViewport(true);
  // 14 条同段对话：入口取第 2 条，新进入时居中位置是 146（见 conversation-reading 的排版替身）。
  const items = replies(14).map((item, index) => ({
    ...item, parentId: index === 0 ? null : replies(1)[0]!.id,
  }));
  const entry = items[1]!;
  const conversationPath = `/dynamics/${dynamicId}/comments/${rootId}/replies/${entry.id}/conversation`;
  const reads: string[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => ({ status: 'success', data: pageBatch(input.sort ?? 'time', input.page ?? 1) }),
    readConversation: async input => {
      reads.push(input.replyId);
      return {
        status: 'success',
        data: {
          dynamicId, rootId, replyId: input.replyId, startId: items[0]!.id,
          incomplete: false, count: items.length, nextCursor: null, items,
        },
      };
    },
  });

  const router = await showApp(reader, conversationPath);
  expect(await screen.findByRole('list', { name: '对话内容' })).toBeTruthy();
  // 新进入：一次整段读取并把入口回复定位到视口中央。
  await waitFor(() => expect(layout.scrollY()).toBe(146));
  expect(reads).toEqual([entry.id]);

  // 用户往下读了一段：这是这次访问的位置。
  layout.setScrollY(600);
  await settle();

  // 离开再回到同一访问（浏览器后退）：优先恢复位置，不重新居中。
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  await settle();
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
  expect(await screen.findByRole('list', { name: '对话内容' })).toBeTruthy();
  await waitFor(() => expect(layout.scrollY()).toBe(600));
  // 内容仍每次单次整段读取（不缓存会话），但落点是恢复的位置而不是重新定位。
  expect(reads).toEqual([entry.id, entry.id]);
});

it('会话内容还没显示就离开：历史前进回来仍定位，不恢复无内容时的位置', async () => {
  installCompactViewport(true);
  // 14 条同段对话：入口取第 2 条，居中位置仍是 146（见 conversation-reading 的排版替身）。
  const items = replies(14).map((item, index) => ({
    ...item, parentId: index === 0 ? null : replies(1)[0]!.id,
  }));
  const entry = items[1]!;
  const conversationPath = `/dynamics/${dynamicId}/comments/${rootId}/replies/${entry.id}/conversation`;
  /** 楼中楼列表里给入口回复带上对话投影：会话只能从真实入口进入，才有可后退的来源。 */
  const entryBatch = (): ReplyBatch => {
    const batch = pageBatch('time', 1);
    return {
      ...batch,
      items: batch.items.map((item, index) => (index === 1
        ? { ...item, conversation: { startId: batch.items[0]!.id, count: 2, incomplete: false } }
        : item)),
    };
  };

  // 读取中与读取失败都没有显示任何回复：两者都不是“已经显示过的访问”。
  for (const preDisplay of ['loading', 'error'] as const) {
    cleanup();
    layout.setScrollY(0);
    const pending = deferred<ConversationResult>();
    let reads = 0;
    const reader = createReader({
      readDetail: async () => ({ status: 'success', data: commentDynamic() }),
      readReplies: async () => ({ status: 'success', data: entryBatch() }),
      readConversation: async input => {
        reads += 1;
        // 第一次进入停在显示之前；历史前进回来那次正常读完。
        if (reads === 1) return preDisplay === 'loading' ? pending.promise : { status: 'error' };
        return {
          status: 'success',
          data: {
            dynamicId, rootId, replyId: input.replyId, startId: items[0]!.id,
            incomplete: false, count: items.length, nextCursor: null, items,
          },
        };
      },
    });

    const router = await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
    await waitFor(() => expect(within(replyList()).getAllByRole('listitem')).toHaveLength(10));
    // 用户已经在页面别处读过一段：这是无内容时的滚动位置，不是这次会话的阅读位置。
    layout.setScrollY(300);
    await settle();
    await fireEvent.click(within(entryOf(entry)).getByRole('button', { name: '查看对话' }));
    await waitFor(() => expect(router.currentRoute.value.path).toBe(conversationPath));
    const notice = preDisplay === 'loading' ? '会话加载中…' : '会话读取失败，请重试。';
    await waitFor(() => expect(screen.getByText(notice)).toBeTruthy());
    expect(screen.queryByRole('list', { name: '对话内容' })).toBeNull();

    // 就在这时离开这次访问：没有任何“已经显示过”的位置可以保存。
    await fireEvent.click(screen.getByRole('button', { name: '会话列表，返回评论详情' }));
    await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
    await settle();

    // 历史前进到这同一次访问：这次读取成功，入口回复要重新定位。
    await router.go(1);
    await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
    expect(await screen.findByRole('list', { name: '对话内容' })).toBeTruthy();
    await waitFor(() => expect(layout.scrollY()).toBe(146));
  }
});

it('短会话末条只贴到底：定位不补留白，历史恢复也不靠留白撑范围', async () => {
  installCompactViewport(true);
  // 短会话：两条内容不足一屏；文档高度 830 比视口 768 只多 62，可滚动上限就是 62。
  layout.setScrollHeight(830);
  const items = replies(2).map((item, index) => ({
    ...item, parentId: index === 0 ? null : replies(1)[0]!.id,
  }));
  const entry = items[1]!;
  const conversationPath = `/dynamics/${dynamicId}/comments/${rootId}/replies/${entry.id}/conversation`;
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async input => ({ status: 'success', data: pageBatch(input.sort ?? 'time', input.page ?? 1) }),
    readConversation: async input => ({
      status: 'success',
      data: {
        dynamicId, rootId, replyId: input.replyId, startId: items[0]!.id,
        incomplete: false, count: items.length, nextCursor: null, items,
      },
    }),
  });

  const router = await showApp(reader, conversationPath);
  const list = await screen.findByRole('list', { name: '对话内容' });
  // 末条居中位置 146 超过可滚动上限 62：夹到 62，不为居中把列表撑高。
  await waitFor(() => expect(layout.scrollY()).toBe(62));
  expect((list as HTMLElement).style.paddingTop).toBe('');
  expect((list as HTMLElement).style.paddingBottom).toBe('');

  // 用户回读前文：这是这次访问的位置。
  layout.setScrollY(10);
  await settle();

  // 离开再按历史回到同一访问：位置照旧还原，可滚动范围不依赖任何居中留白。
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  await settle();
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
  const restored = await screen.findByRole('list', { name: '对话内容' });
  await waitFor(() => expect(layout.scrollY()).toBe(10));
  expect((restored as HTMLElement).style.paddingBottom).toBe('');
});
