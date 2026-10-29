import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Comment, DynamicReader, Reply, ReplyBatch } from '../../src/data/contracts';
import { comment, commentDynamic, comments } from '../fixtures/comments';
import { reply, replies } from '../fixtures/replies';
import { createReader, deferred } from '../support/reader';
import { showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { installCompactViewport, removeCompactViewport } from '../support/viewport';

const dynamicId = '1001';
const rootId = comment(1).id;
const upAuthor = { id: '123', nickname: '动态作者', avatarUrl: null };

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

function pageBatch(
  total: number,
  page: number,
  root: Comment = rootComment(),
  overrides: Partial<ReplyBatch> = {},
): ReplyBatch {
  const offset = (page - 1) * 10;
  return {
    items: replies(total).slice(offset, offset + 10),
    nextCursor: null,
    count: total,
    localReplyCount: total,
    sourceReplyCount: total,
    root,
    ...overrides,
  };
}

function threadReader(reader: Partial<DynamicReader>) {
  return createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    ...reader,
  });
}

async function openThread(path = `/dynamics/${dynamicId}/comments/${rootId}`) {
  const router = await showApp(threadReader({
    readReplies: async input => ({
      status: 'success', data: pageBatch(25, input.page ?? 1),
    }),
  }), path);
  return router;
}

it('直达楼中楼按 page=1&limit=10 读取：展示根评论、回复与分页，不渲染图片也不折叠', async () => {
  const seen: ReplyRequest[] = [];
  const root = rootComment({
    isPinned: true,
    images: [{ id: 'img-1', thumbnailUrl: '/t.png', previewUrl: '/p.png', width: 10, height: 10 }],
  });
  const items: Reply[] = replies(10).map((item, index) =>
    index === 0 ? { ...item, author: upAuthor } : item);
  const reader = threadReader({
    readReplies: async input => {
      seen.push(requestOf(input));
      return {
        status: 'success',
        data: { items, nextCursor: null, count: 25, localReplyCount: 25, sourceReplyCount: 25, root },
      };
    },
  });

  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);

  const article = await screen.findByRole('article', { name: '被回复的评论' });
  expect(article.textContent).toContain('被回复的根评论');
  expect(article.textContent).toContain('置顶');
  // 该页不展示图片：根评论与回复的图片都不挂载。
  expect(document.querySelector('img[src="/t.png"]')).toBeNull();
  expect(document.querySelector('img[src="/p.png"]')).toBeNull();

  const list = screen.getByRole('list', { name: '相关回复' });
  const entries = within(list).getAllByRole('listitem');
  expect(entries).toHaveLength(10);
  expect(entries.map(item => item.dataset.readingId))
    .toEqual(items.map(item => `reply:${rootId}:${item.id}`));
  // UP 标识按作者 ID：只有动态作者的回复带标识。
  expect(entries[0]!.textContent).toContain('UP主');
  expect(entries[1]!.textContent).not.toContain('UP主');
  expect(screen.queryByRole('button', { name: '展开回复正文' })).toBeNull();
  expect(screen.queryByRole('button', { name: '展开评论' })).toBeNull();

  expect(screen.getByText('相关回复共25条')).toBeTruthy();
  // 宽屏内联楼中楼保留原时间序：不增加排序控件，但页码读取仍显式声明时间序。
  expect(screen.queryByRole('button', { name: /^当前按/ })).toBeNull();
  const pager = screen.getByRole('navigation', { name: '回复分页' });
  expect(within(pager).getByText('共3页')).toBeTruthy();
  expect(within(pager).getByRole('button', { name: '1' }).getAttribute('aria-current')).toBe('page');

  // 页码模式：固定每页 10 条，不带 cursor（no-store 由 Adapter 用例覆盖）。
  expect(seen).toEqual([{ rootId, limit: 10, page: 1, cursor: undefined, sort: 'time' }]);
});

it('页头数量按来源数→本地 count→items 数回退，分页只按本地 count 计算', async () => {
  const reader = threadReader({
    readReplies: async () => ({
      status: 'success', data: { items: replies(10), nextCursor: null, count: 12, root: rootComment() },
    }),
  });
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  expect(await screen.findByText('相关回复共12条')).toBeTruthy();
  expect(within(screen.getByRole('navigation', { name: '回复分页' })).getByText('共2页')).toBeTruthy();

  cleanup();
  const withSource = threadReader({
    readReplies: async () => ({
      status: 'success',
      data: {
        items: replies(10), nextCursor: null, count: 12, localReplyCount: 8, sourceReplyCount: 25,
        root: rootComment(),
      },
    }),
  });
  await showApp(withSource, `/dynamics/${dynamicId}/comments/${rootId}`);
  // 页头用来源总数，分页用本地数，未被上游返回的差额单独说明。
  expect(await screen.findByText('相关回复共25条')).toBeTruthy();
  expect(screen.getByText('已保存 8/25，上游另有 17 条回复未返回。')).toBeTruthy();
  // 分页只按本地 count（12 条）算 2 页，不被来源 25 条或归档摘要 8 条带偏。
  expect(within(screen.getByRole('navigation', { name: '回复分页' })).getByText('共2页')).toBeTruthy();

  cleanup();
  // 只有来源数、没有本地归档摘要时不编造“已保存 x/y”的差额提示。
  const withoutLocal = threadReader({
    readReplies: async () => ({
      status: 'success',
      data: { items: replies(10), nextCursor: null, count: 12, sourceReplyCount: 25, root: rootComment() },
    }),
  });
  await showApp(withoutLocal, `/dynamics/${dynamicId}/comments/${rootId}`);
  expect(await screen.findByText('相关回复共25条')).toBeTruthy();
  expect(screen.queryByText(/未返回/)).toBeNull();
});

it('每页替换当前页：25 条按 10/10/5 翻页，数据缩减后越界页重读有效末页', async () => {
  const seen: ReplyRequest[] = [];
  let total = 25;
  const reader = threadReader({
    readReplies: async input => {
      seen.push(requestOf(input));
      return { status: 'success', data: pageBatch(total, input.page ?? 1) };
    },
  });

  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  const list = await screen.findByRole('list', { name: '相关回复' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(10);

  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(within(list).getAllByRole('listitem')[0]!.dataset.readingId)
    .toBe(`reply:${rootId}:${replies(25)[10]!.id}`));
  expect(seen.at(-1)).toEqual({ rootId, limit: 10, page: 2, cursor: undefined, sort: 'time' });

  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(5));
  expect(within(list).getAllByRole('listitem')[4]!.dataset.readingId)
    .toBe(`reply:${rootId}:${replies(25)[24]!.id}`);

  // 本地回复被删到 12 条：第 3 页变空后改为真实读取最新末页。
  total = 12;
  await fireEvent.click(screen.getByRole('button', { name: '3' }));
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
  expect(seen.slice(-2).map(item => item.page)).toEqual([3, 2]);
  expect(within(list).getAllByRole('listitem')[1]!.dataset.readingId)
    .toBe(`reply:${rootId}:${replies(12)[11]!.id}`);
  expect(within(screen.getByRole('navigation', { name: '回复分页' })).getByText('共2页')).toBeTruthy();
});

it('分页器收起与返回按钮都退回详情，并保持详情已读内容不重读', async () => {
  installCompactViewport(true);
  let commentReads = 0;
  let threadReads = 0;
  const reader = createReader({
    readUps: async () => ({ status: 'success', data: [] }),
    readList: async () => ({ status: 'success', data: { items: [commentDynamic()], nextCursor: null } }),
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => {
      commentReads += 1;
      return commentReads === 1
        ? { status: 'success', data: { items: [comment(1, { replyCount: 25 }), ...comments(20).slice(1)], nextCursor: 'c20' } }
        : { status: 'success', data: { items: comments(40).slice(20), nextCursor: null } };
    },
    readReplies: async input => {
      threadReads += 1;
      return { status: 'success', data: pageBatch(25, input.page ?? 1) };
    },
  });

  const router = await showApp(reader, '/');
  await screen.findByText('详情正文');
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(40));
  layout.setScrollY(500);

  await fireEvent.click(within(region).getAllByRole('button', { name: /条回复/ })[0]!);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  // 楼中楼不继承详情位置：重新挂载从顶部开始。
  await waitFor(() => expect(layout.scrollY()).toBe(0));
  expect(await screen.findByText('相关回复共25条')).toBeTruthy();

  const readsBeforeBack = commentReads;
  await fireEvent.click(screen.getByRole('button', { name: '评论详情，返回动态详情' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const restored = await screen.findByRole('region', { name: '评论区' });
  // 详情按自己的快照恢复：40 条已读内容与位置都在，不因进出楼中楼重读。
  expect(within(restored).getAllByRole('listitem')).toHaveLength(40);
  expect(commentReads).toBe(readsBeforeBack);
  await waitFor(() => expect(layout.scrollY()).toBe(500));

  // 前进回到楼中楼：重新挂载仍从第 1 页/顶部开始，不记忆上次的第 2 页。
  await fireEvent.click(within(restored).getAllByRole('button', { name: /条回复/ })[0]!);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  const reopened = await screen.findByRole('list', { name: '相关回复' });
  expect(within(reopened).getAllByRole('listitem')).toHaveLength(10);
  expect(within(screen.getByRole('navigation', { name: '回复分页' }))
    .getByRole('button', { name: '1' }).getAttribute('aria-current')).toBe('page');
  expect(threadReads).toBeGreaterThan(0);
  await waitFor(() => expect(layout.scrollY()).toBe(0));

  // 分页器收起同样回到详情。
  const pager = screen.getByRole('navigation', { name: '回复分页' });
  await fireEvent.click(within(pager).getByRole('button', { name: '收起' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
});

it('返回控件可访问名包含可见标签“评论详情”，并说明返回的是动态详情', async () => {
  await openThread();
  await screen.findByText('相关回复共25条');

  const back = screen.getByRole('button', { name: '评论详情，返回动态详情' });
  // 可见标签 `‹ 评论详情` 必须出现在无障碍名里（Label in Name），名里再说明返回目标。
  expect(back.textContent).toBe('‹ 评论详情');
  expect(back.getAttribute('aria-label')).toContain('评论详情');
  expect(back.getAttribute('aria-label')).toContain('动态详情');
});

it('无详情来源时返回用 replace 定位对应动态详情，历史里不保留楼中楼', async () => {
  const router = await openThread();
  await screen.findByText('相关回复共25条');

  await fireEvent.click(screen.getByRole('button', { name: '评论详情，返回动态详情' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  expect(router.currentRoute.value.path).toBe(`/dynamics/${dynamicId}`);

  // replace 后回退不会再次进入楼中楼。
  await router.go(-1);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(router.currentRoute.value.name).toBe('detail');
});

it('只有 CURSOR_INVALID 显示失效标记并可重新开始读取，普通错误按可重试读取处理', async () => {
  const seen: ReplyRequest[] = [];
  let mode: 'invalid' | 'failed' | 'ok' = 'invalid';
  const reader = threadReader({
    readReplies: async input => {
      seen.push(requestOf(input));
      if (mode === 'invalid') return { status: 'error', reason: 'invalid-cursor' };
      if (mode === 'failed') return { status: 'error' };
      return { status: 'success', data: pageBatch(25, input.page ?? 1) };
    },
  });

  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  expect((await screen.findByRole('alert')).textContent).toBe('回复读取标记无效，请重新开始读取。');
  mode = 'ok';
  await fireEvent.click(screen.getByRole('button', { name: '重新开始读取' }));
  const list = await screen.findByRole('list', { name: '相关回复' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  expect(seen.map(item => item.page)).toEqual([1, 1]);
  expect(screen.queryByRole('alert')).toBeNull();

  // 翻页时才失效：保留当前页已读内容，同时给出重开入口，分页按钮禁用。
  mode = 'invalid';
  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect((await screen.findByRole('alert')).textContent).toBe('回复读取标记无效，请重新开始读取。');
  expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true);
  mode = 'ok';
  await fireEvent.click(screen.getByRole('button', { name: '重新开始读取' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(within(list).getAllByRole('listitem')).toHaveLength(10);
  expect(seen.map(item => item.page)).toEqual([1, 1, 2, 1]);

  cleanup();
  mode = 'failed';
  const failed = threadReader({
    readReplies: async input => {
      seen.push(requestOf(input));
      return mode === 'failed' ? { status: 'error' } : { status: 'success', data: pageBatch(25, input.page ?? 1) };
    },
  });
  await showApp(failed, `/dynamics/${dynamicId}/comments/${rootId}`);
  expect((await screen.findByRole('alert')).textContent).toBe('相关回复读取失败，请重试。');
  expect(seen.at(-1)).toEqual({ rootId, limit: 10, page: 1, cursor: undefined, sort: 'time' });
  mode = 'ok';
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('list', { name: '相关回复' })).toBeTruthy();
});

it('UP 标识的额外详情读取只用于身份，失败或取消都不阻断回复主读取', async () => {
  const reader = createReader({
    readDetail: async () => ({ status: 'error' }),
    readReplies: async () => ({
      status: 'success',
      data: {
        items: [{ ...reply(1), author: upAuthor }], nextCursor: null, count: 1, root: rootComment(),
      },
    }),
  });

  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  const list = await screen.findByRole('list', { name: '相关回复' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  expect(list.textContent).not.toContain('UP主');
  // 辅助读取失败不产生错误提示，只在主读取自身失败时才提示。
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('相关回复共1条')).toBeTruthy();
});

it('成功空结果直接显示暂无回复，不伪造详情式 not-found', async () => {
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async () => ({
      status: 'success',
      data: {
        items: [], nextCursor: null, count: 0, localReplyCount: 0, sourceReplyCount: 3,
        root: rootComment(), repliesLastAttempt: 'pending',
      },
    }),
  });

  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  expect(await screen.findByText('暂无回复')).toBeTruthy();
  expect(screen.getByText('相关回复共3条')).toBeTruthy();
  expect(screen.queryByText(/不存在/)).toBeNull();
  // 0 条回复不显示分页器之外的错误或结束结语。
  expect(screen.queryByRole('alert')).toBeNull();
});

it('离开楼中楼后迟到的翻页结果不改写详情，重新进入仍从第 1 页开始', async () => {
  installCompactViewport(true);
  const pending = deferred<Awaited<ReturnType<DynamicReader['readReplies']>>>();
  const seen: ReplyRequest[] = [];
  const reader = createReader({
    readUps: async () => ({ status: 'success', data: [] }),
    readList: async () => ({ status: 'success', data: { items: [commentDynamic()], nextCursor: null } }),
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => ({
      status: 'success', data: { items: [comment(1, { replyCount: 25 })], nextCursor: null },
    }),
    readReplies: async input => {
      seen.push(requestOf(input));
      if (input.page === 2) return pending.promise;
      return { status: 'success', data: pageBatch(25, input.page ?? 1) };
    },
  });

  const router = await showApp(reader, '/');
  await screen.findByText('详情正文');
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('button', { name: /条回复/ })).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: /条回复/ }));

  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  await fireEvent.click(await screen.findByRole('button', { name: '下一页' }));
  await waitFor(() => expect(seen.at(-1)!.page).toBe(2));
  await fireEvent.click(screen.getByRole('button', { name: '评论详情，返回动态详情' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));

  // 迟到的成功/失败都不再影响已离开的页面或当前详情。
  pending.resolve({ status: 'error' });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(screen.getByText('详情正文')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();

  await fireEvent.click(within(await screen.findByRole('region', { name: '评论区' }))
    .getByRole('button', { name: /条回复/ }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  await screen.findByRole('list', { name: '相关回复' });
  expect(seen.at(-1)).toEqual({ rootId, limit: 10, page: 1, cursor: undefined, sort: 'time' });
});

/** jsdom 没有 scrollIntoView：记录被定位的元素，验证定位落在目标回复而不是页面顶部。 */
function recordScrollIntoView(): Element[] {
  const scrolled: Element[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: Element) { scrolled.push(this); },
  });
  return scrolled;
}

function locatePath(replyId: string): string {
  return `/dynamics/${dynamicId}/comments/${rootId}/replies/${replyId}/locate`;
}

it('窄屏精确入口直达目标所在页并高亮该条：不回第一页，也不先回到页面顶部', async () => {
  installCompactViewport(true);
  const scrolled = recordScrollIntoView();
  const target = replies(25)[13]!;
  const located: string[] = [];
  const pageReads: ReplyRequest[] = [];
  const reader = threadReader({
    readReplies: async input => {
      pageReads.push(requestOf(input));
      return { status: 'success', data: pageBatch(25, input.page ?? 1) };
    },
    locateReply: async input => {
      located.push(input.replyId);
      return {
        status: 'success',
        data: { ...pageBatch(25, 2), page: 2,
          items: pageBatch(25, 2).items.map(item =>
            item.id === target.id ? { ...item, text: locateLongText } : item) },
      };
    },
  });

  const router = await showApp(reader, locatePath(target.id));
  const list = await screen.findByRole('list', { name: '相关回复' });
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(10));

  // 只有一次定位读取：不先读第 1 页，也不为此渲染全部回复。
  expect(located).toEqual([target.id]);
  expect(pageReads).toEqual([]);
  const entries = within(list).getAllByRole('listitem');
  expect(entries.map(item => item.dataset.readingId)).toEqual(replies(25).slice(10, 20).map(item => `reply:${rootId}:${item.id}`));
  const marked = entries.filter(item => item.getAttribute('data-located') === 'true');
  expect(marked.map(item => item.dataset.readingId)).toEqual([`reply:${rootId}:${target.id}`]);
  expect(marked[0]!.getAttribute('aria-current')).toBe('true');
  expect(scrolled.at(-1)).toBe(marked[0]);
  // 楼中楼正文不折叠：定位可读，不需要展开动作。
  expect(within(marked[0]!).queryByRole('button', { name: /回复正文/ })).toBeNull();
  expect(within(marked[0]!).getByText('第七行边界 7', { exact: false })).toBeTruthy();
  // 页头与分页仍按本地总数：停在目标页，不重置为第一页。
  expect(screen.getByText('相关回复共25条')).toBeTruthy();
  expect(screen.getByRole('article', { name: '被回复的评论' })).toBeTruthy();
  const pager = screen.getByRole('navigation', { name: '回复分页' });
  expect(within(pager).getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');
  // 定位模式不先滚到页面顶部再找目标。
  expect(layout.scrollTo).not.toHaveBeenCalled();

  // 定位后的普通翻页仍是原页内替换。
  await fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(5));
  expect(pageReads.at(-1)).toEqual({ rootId, limit: 10, page: 3, cursor: undefined, sort: 'time' });

  // 返回仍按无详情来源的规则替换为对应动态详情。
  await fireEvent.click(screen.getByRole('button', { name: '评论详情，返回动态详情' }));
  await waitFor(() => expect(router.currentRoute.value.path).toBe(`/dynamics/${dynamicId}`));
});

it('窄屏精确入口：目标不存在可返回动态，临时失败可局部重试后再定位', async () => {
  installCompactViewport(true);
  recordScrollIntoView();
  const missing = threadReader({ locateReply: async () => ({ status: 'not-found' }) });
  const router = await showApp(missing, locatePath('9999'));
  const notice = () => screen.getByRole('region', { name: '定位结果' });
  await waitFor(() => expect(within(notice()).getByRole('status').textContent).toContain('不存在或未保存'));
  expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  await fireEvent.click(within(notice()).getByRole('button', { name: '返回动态' }));
  await waitFor(() => expect(router.currentRoute.value.path).toBe(`/dynamics/${dynamicId}`));

  cleanup();
  const target = replies(25)[13]!;
  const attempts: string[] = [];
  const retrying = threadReader({
    locateReply: async input => {
      attempts.push(input.replyId);
      if (attempts.length === 1) return { status: 'error' };
      return { status: 'success', data: { ...pageBatch(25, 2), page: 2 } };
    },
  });
  await showApp(retrying, locatePath(target.id));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('读取失败'));
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.getByRole('list', { name: '相关回复' })).toBeTruthy());
  const marked = within(screen.getByRole('list', { name: '相关回复' }))
    .getAllByRole('listitem').filter(item => item.getAttribute('data-located') === 'true');
  expect(marked.map(item => item.dataset.readingId)).toEqual([`reply:${rootId}:${target.id}`]);
  expect(attempts).toEqual([target.id, target.id]);
});

const locateLongText = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：楼中楼正文直接展示，不新增折叠。`).join('\n');
