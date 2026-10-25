import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DynamicReader, ReplyBatch } from '../../src/data/contracts';
import { comment, commentDynamic } from '../fixtures/comments';
import { reply, replies } from '../fixtures/replies';
import { createReader, deferred } from '../support/reader';
import { showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
  vi.restoreAllMocks();
});

interface ReplyRequest {
  rootId: string;
  limit: number;
  page: number | undefined;
  cursor: string | null | undefined;
}

function replySignal(input: { rootId: string; limit: number; page?: number; cursor?: string | null }): ReplyRequest {
  return { rootId: input.rootId, limit: input.limit, page: input.page, cursor: input.cursor };
}

function pageBatch(total: number, page: number): ReplyBatch {
  const all = replies(total);
  const offset = (page - 1) * 10;
  return { items: all.slice(offset, offset + 10), nextCursor: null, count: total,
    sourceReplyCount: total, localReplyCount: total, repliesLastAttempt: 'success' };
}

/** 详情 + 一级评论的公共读取；回复读取由各用例决定。 */
/**
 * 宽屏回复精确入口仍复用一级评论定位读取：先用 02 的契约取含所属根评论的批次，
 * 再由该根的回复区按目标身份定位。这里把它作为默认读取提供。
 */
function locateRootReader(reader: Partial<DynamicReader>) {
  return detailReader({
    locateComment: async () => ({
      status: 'success',
      data: { items: [comment(1, { replyCount: 25 })], nextCursor: null },
    }),
    ...reader,
  });
}

function detailReader(reader: Partial<DynamicReader>, roots = [comment(1, { replyCount: 25 })]) {
  return createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => ({ status: 'success', data: { items: roots, nextCursor: null } }),
    ...reader,
  });
}

function commentItem(index = 1): HTMLElement {
  const item = document.querySelector<HTMLElement>(`[data-reading-id="comment:${comment(index).id}"]`);
  if (!item) throw new Error(`找不到一级评论 ${index} 的容器`);
  return item;
}

function replyList(index = 1): HTMLElement[] {
  return within(commentItem(index)).queryAllByRole('list', { name: '回复列表' });
}

it('宽屏为有回复的一级评论读 3 条 cursor 预览，并提供展开入口', async () => {
  const seen: ReplyRequest[] = [];
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.rootId !== comment(1).id) throw new Error('回复数为 0 的一级评论不应读取回复');
      return { status: 'success', data: { items: replies(3), nextCursor: 'preview-more', sourceReplyCount: 25 } };
    },
  }, [comment(1, { replyCount: 25 }), comment(2, { replyCount: 0 })]);

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));

  expect(seen).toEqual([{ rootId: comment(1).id, limit: 3, page: undefined, cursor: undefined }]);
  const list = replyList(1)[0]!;
  expect(within(list).getAllByRole('listitem').map(item => item.dataset.readingId))
    .toEqual(replies(3).map(item => `reply:${comment(1).id}:${item.id}`));
  expect(within(region).getByRole('button', { name: '展开回复' })).toBeTruthy();
  expect(within(commentItem(2)).queryByRole('button', { name: '展开回复' })).toBeNull();
  expect(within(commentItem(2)).queryByRole('list', { name: '回复列表' })).toBeNull();
});

it('展开用 page+limit=10 读第 1 页，翻页按 10/10/5 替换当前页，同页重读也发真实请求', async () => {
  const seen: ReplyRequest[] = [];
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.page === undefined) {
        return { status: 'success', data: { items: replies(3), nextCursor: 'more', sourceReplyCount: 25 } };
      }
      return { status: 'success', data: pageBatch(25, input.page) };
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));

  const list = () => replyList(1)[0]!;
  await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(10));
  expect(seen.at(-1)).toEqual({ rootId: comment(1).id, limit: 10, page: 1, cursor: undefined });
  expect(within(list()).getAllByRole('listitem').map(item => item.dataset.readingId))
    .toEqual(replies(10).map(item => `reply:${comment(1).id}:${item.id}`));
  expect(within(region).getByText('共3页')).toBeTruthy();
  // 展开后不再提供展开入口，改为分页与收起。
  expect(within(region).queryByRole('button', { name: '展开回复' })).toBeNull();
  expect(within(region).getByRole('button', { name: '收起' })).toBeTruthy();

  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(10));
  expect(seen.at(-1)).toEqual({ rootId: comment(1).id, limit: 10, page: 2, cursor: undefined });
  expect(within(list()).getAllByRole('listitem')[0]!.dataset.readingId)
    .toBe(`reply:${comment(1).id}:${replies(25)[10]!.id}`);

  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(5));
  expect(seen.at(-1)!.page).toBe(3);
  expect(within(list()).getAllByRole('listitem')[4]!.dataset.readingId)
    .toBe(`reply:${comment(1).id}:${replies(25)[24]!.id}`);
  expect((within(region).getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled).toBe(true);

  // 显式点击当前页：不使用页缓存，仍发真实请求。
  const before = seen.length;
  await fireEvent.click(within(region).getByRole('button', { name: '3' }));
  await waitFor(() => expect(seen.length).toBe(before + 1));
  expect(seen.at(-1)).toEqual({ rootId: comment(1).id, limit: 10, page: 3, cursor: undefined });
  expect(within(list()).getAllByRole('listitem')).toHaveLength(5);
});

/** jsdom 没有 scrollIntoView：记录被定位的元素，验证收起后定位到根评论开头。 */
function recordScrollIntoView(): Element[] {
  const scrolled: Element[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: Element) { scrolled.push(this); },
  });
  return scrolled;
}

it('收起取消在途请求、定位根评论开头并保存第 1 页，再次展开重新首读', async () => {
  const scrolled = recordScrollIntoView();
  const seen: ReplyRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const pending = deferred<Awaited<ReturnType<DynamicReader['readReplies']>>>();
  let pendingSignal: AbortSignal | undefined;
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.page === undefined) {
        return { status: 'success', data: { items: replies(3), nextCursor: 'more', sourceReplyCount: 25 } };
      }
      if (input.page === 1) return { status: 'success', data: pageBatch(25, 1) };
      signals.push(input.signal);
      pendingSignal = input.signal;
      return pending.promise;
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(10));

  // 第 2 页请求在途时收起。
  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(seen.at(-1)!.page).toBe(2));
  await fireEvent.click(within(region).getByRole('button', { name: '收起' }));

  await waitFor(() => expect(pendingSignal?.aborted).toBe(true));
  expect(signals).toHaveLength(1);
  await waitFor(() => expect(
    scrolled.at(-1)?.getAttribute('data-reading-id')).toBe(`comment:${comment(1).id}`));
  // 收起后回到 3 条预览并保留原预览结果，不重读首批。
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(3));
  expect(within(region).queryByRole('navigation', { name: '回复分页' })).toBeNull();
  expect(seen.filter(item => item.page === undefined)).toHaveLength(1);

  // 迟到成功被丢弃：仍在预览态，不出现分页器。
  pending.resolve({ status: 'success', data: pageBatch(25, 2) });
  await waitFor(() => expect(seen.at(-1)!.page).toBe(2));
  expect(within(region).queryByRole('navigation', { name: '回复分页' })).toBeNull();

  // 再次展开重新读第 1 页，而不是恢复旧的第 2 页。
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  await waitFor(() => expect(seen.at(-1)).toEqual({ rootId: comment(1).id, limit: 10, page: 1, cursor: undefined }));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(10));
});

it('详情历史恢复展开状态与页码，并实时重读保存页而不是复用冻结结果', async () => {
  const seen: ReplyRequest[] = [];
  let generation = 1;
  const reader = createReader({
    readUps: async () => ({ status: 'success', data: [] }),
    readList: async () => ({ status: 'success', data: { items: [commentDynamic()], nextCursor: null } }),
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => ({
      status: 'success', data: { items: [comment(1, { replyCount: 25 })], nextCursor: null },
    }),
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.page === undefined) {
        return { status: 'success', data: { items: replies(3), nextCursor: 'more', sourceReplyCount: 25 } };
      }
      const current = pageBatch(25, input.page);
      return { status: 'success', data: {
        ...current,
        items: current.items.map(item => ({ ...item, text: `${item.text}（第${generation}次读取）` })),
      } };
    },
  });

  const router = await showApp(reader, '/');
  await screen.findByText('详情正文');
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(10));
  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(seen.at(-1)!.page).toBe(2));
  expect(within(replyList(1)[0]!).getAllByRole('listitem')[0]!.textContent).toContain('第1次读取');

  // 离开详情再按历史返回：展开状态与页码进入访问快照。
  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  const beforeRestore = seen.length;
  generation = 2;
  await router.go(1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));

  const restored = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(10));
  // 已展开：按保存的第 2 页实时重读，展示的是新结果而不是冻结页。
  expect(seen.slice(beforeRestore)).toEqual([
    { rootId: comment(1).id, limit: 10, page: 2, cursor: undefined },
  ]);
  expect(within(replyList(1)[0]!).getAllByRole('listitem')[0]!.textContent).toContain('第2次读取');
  const pager = within(restored).getByRole('navigation', { name: '回复分页' });
  expect(pager.querySelector('[aria-current="page"]')?.textContent).toBe('2');
  // 预览结果随快照恢复，不重复读首批。
  expect(within(restored).queryByRole('button', { name: '展开回复' })).toBeNull();
});

it('数量缩减导致页码越界时重读有效末页，分页只按本地总数计算', async () => {
  const seen: ReplyRequest[] = [];
  let total = 25;
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.page === undefined) {
        return { status: 'success', data: { items: replies(3), nextCursor: 'more', sourceReplyCount: 25 } };
      }
      return { status: 'success', data: pageBatch(total, input.page) };
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  const list = () => replyList(1)[0]!;
  await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(10));

  // 每页 nextCursor 都是 null，但本地 25 条仍分 3 页。
  await fireEvent.click(within(region).getByRole('button', { name: '3' }));
  await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(5));
  expect(within(region).getByRole('button', { name: '3' }).getAttribute('aria-current')).toBe('page');

  // 本地回复被删到 12 条：原第 3 页变空，改用最新总数重读末页。
  total = 12;
  await fireEvent.click(within(region).getByRole('button', { name: '3' }));
  await waitFor(() => expect(seen.filter(item => item.page === 2).length).toBeGreaterThan(0));
  await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(2));
  expect(seen.slice(-2).map(item => item.page)).toEqual([3, 2]);
  expect(within(list()).getAllByRole('listitem').map(item => item.dataset.readingId))
    .toEqual(replies(12).slice(10).map(item => `reply:${comment(1).id}:${item.id}`));
  expect(within(region).getByText('共2页')).toBeTruthy();
  expect(within(region).getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');
});

it('单个回复区失败只影响该区域并保留已有评论，重试沿用同一请求', async () => {
  const first = comment(1, { replyCount: 25 });
  const second = comment(2, { replyCount: 25 });
  const seen: ReplyRequest[] = [];
  let attempts = 0;
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.rootId === second.id) {
        return { status: 'success', data: { items: [reply(100), reply(101)], nextCursor: null } };
      }
      attempts += 1;
      return attempts === 1
        ? { status: 'error' }
        : { status: 'success', data: { items: replies(3), nextCursor: 'more' } };
    },
  }, [first, second]);

  await showApp(reader, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(2)).toHaveLength(1));
  // 第二个回复区正常展示，第一个只说读取失败，一级评论本身不受影响。
  expect(within(replyList(2)[0]!).getAllByRole('listitem')).toHaveLength(2);
  expect(within(commentItem(1)).getByRole('alert').textContent).toBe('回复读取失败，请重试。');
  expect(within(commentItem(1)).getByText('一级评论 1')).toBeTruthy();
  expect(within(commentItem(2)).queryByRole('alert')).toBeNull();

  const failures = seen.length;
  await fireEvent.click(within(commentItem(1)).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  expect(seen).toHaveLength(failures + 1);
  expect(seen.at(-1)).toEqual({ rootId: first.id, limit: 3, page: undefined, cursor: undefined });
  expect(within(commentItem(1)).queryByRole('alert')).toBeNull();
});

it('只有 CURSOR_INVALID 显示失效标记并可重新开始读取', async () => {
  const seen: ReplyRequest[] = [];
  let attempt = 0;
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      attempt += 1;
      return attempt === 1
        ? { status: 'error', reason: 'invalid-cursor' }
        : { status: 'success', data: { items: replies(2), nextCursor: null } };
    },
  });

  await showApp(reader, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  const alert = await within(commentItem(1)).findByRole('alert');
  expect(alert.textContent).toBe('回复读取标记无效，请重新开始读取。');
  expect(within(commentItem(1)).queryByRole('button', { name: '展开回复' })).toBeNull();

  await fireEvent.click(within(commentItem(1)).getByRole('button', { name: '重新开始读取' }));
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  expect(seen).toHaveLength(2);
  expect(within(commentItem(1)).queryByRole('alert')).toBeNull();
});

it('翻页失败保留当前页内容并可按同一页码重试', async () => {
  const seen: ReplyRequest[] = [];
  let failSecond = true;
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.page === undefined) {
        return { status: 'success', data: { items: replies(3), nextCursor: 'more' } };
      }
      if (input.page === 2 && failSecond) {
        failSecond = false;
        return { status: 'error' };
      }
      return { status: 'success', data: pageBatch(25, input.page) };
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  const list = () => replyList(1)[0]!;
  await waitFor(() => expect(within(list()).getAllByRole('listitem')).toHaveLength(10));

  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(within(commentItem(1)).getByRole('alert')).toBeTruthy());
  // 失败只影响本次翻页：当前页 10 条仍在，页码停在 1。
  expect(within(list()).getAllByRole('listitem')).toHaveLength(10);
  expect(within(region).getByRole('button', { name: '1' }).getAttribute('aria-current')).toBe('page');

  await fireEvent.click(within(commentItem(1)).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(seen.at(-1)!.page).toBe(2));
  await waitFor(() => expect(within(list()).getAllByRole('listitem')[0]!.dataset.readingId)
    .toBe(`reply:${comment(1).id}:${replies(25)[10]!.id}`));
  expect(within(commentItem(1)).queryByRole('alert')).toBeNull();
});

it('只有嵌套回复且目标昵称可用时显示“回复 X:”，并剥离来源重复前缀', async () => {
  const nested = reply(1, {
    parentId: '9099',
    replyTo: { id: '7010', nickname: '阿蓝', avatarUrl: null },
    text: '回复 @阿蓝: 嵌套内容',
  });
  const direct = reply(2, { parentId: null, replyTo: null, text: '回复 @某人: 直接回根' });
  const lostTarget = reply(3, { parentId: '9098', replyTo: null, text: '目标缺失' });
  const reader = detailReader({
    readReplies: async () => ({
      status: 'success', data: { items: [nested, direct, lostTarget], nextCursor: null },
    }),
  });

  await showApp(reader, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  const [nestedItem, directItem, lostItem] = within(replyList(1)[0]!).getAllByRole('listitem');

  expect(nestedItem!.querySelector('.reply__target')?.textContent).toBe('回复 阿蓝:');
  expect(nestedItem!.textContent).toContain('嵌套内容');
  // 来源自带的前缀已单独表达，渲染时去掉，不重复显示。
  expect(nestedItem!.textContent).not.toContain('回复 @阿蓝');
  expect(directItem!.querySelector('.reply__target')).toBeNull();
  expect(directItem!.textContent).not.toContain('回复 @某人');
  expect(directItem!.textContent).toContain('直接回根');
  // 目标缺失时不伪造目标，也不丢正文。
  expect(lostItem!.querySelector('.reply__target')).toBeNull();
  expect(lostItem!.textContent).toContain('目标缺失');
});

it('翻页在途时页码按钮禁用，连点不会发出第二个并发请求', async () => {
  const seen: ReplyRequest[] = [];
  const pending = deferred<Awaited<ReturnType<DynamicReader['readReplies']>>>();
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.page === undefined) return { status: 'success', data: { items: replies(3), nextCursor: 'more' } };
      if (input.page === 1) return { status: 'success', data: pageBatch(25, 1) };
      return pending.promise;
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(10));

  const next = within(region).getByRole('button', { name: '下一页' });
  await fireEvent.click(next);
  await waitFor(() => expect(next.hasAttribute('disabled')).toBe(true));
  await fireEvent.click(next);
  await fireEvent.click(next);
  expect(seen.filter(item => item.page === 2)).toHaveLength(1);

  pending.resolve({ status: 'success', data: pageBatch(25, 2) });
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')[0]!.dataset.readingId)
    .toBe(`reply:${comment(1).id}:${replies(25)[10]!.id}`));
});

it('切换排序重置回复展开状态，旧回复区的迟到页码结果不生效', async () => {
  const seen: ReplyRequest[] = [];
  const pending = deferred<Awaited<ReturnType<DynamicReader['readReplies']>>>();
  const reader = createReader({
    readUps: async () => ({ status: 'success', data: [] }),
    readList: async () => ({ status: 'success', data: { items: [commentDynamic()], nextCursor: null } }),
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async input => (input.sort === 'hot'
      ? { status: 'success', data: { items: [comment(1, { replyCount: 25 })], nextCursor: null } }
      : { status: 'success', data: { items: [], nextCursor: null } }),
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.page === undefined) return { status: 'success', data: { items: replies(3), nextCursor: 'more' } };
      if (input.page === 1) return { status: 'success', data: pageBatch(25, 1) };
      return pending.promise;
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(10));
  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(seen.at(-1)!.page).toBe(2));

  await fireEvent.click(within(region).getByRole('radio', { name: '最新' }));
  await waitFor(() => expect(within(region).getByText('暂无评论')).toBeTruthy());
  pending.resolve({ status: 'success', data: pageBatch(25, 2) });
  await waitFor(() => expect(seen.at(-1)!.page).toBe(2));
  expect(within(region).queryByRole('list', { name: '回复列表' })).toBeNull();
  expect(within(region).getByText('暂无评论')).toBeTruthy();

  // 切回最热：回复区重新从预览开始，不沿用旧展开状态。
  await fireEvent.click(within(region).getByRole('radio', { name: '最热' }));
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(3));
  expect(within(region).getByRole('button', { name: '展开回复' })).toBeTruthy();
  expect(within(region).queryByRole('navigation', { name: '回复分页' })).toBeNull();
});

it('离开详情取消在途页码请求，重新进入的新访问不显示旧展开状态', async () => {
  const scrolled = recordScrollIntoView();
  const pending = deferred<Awaited<ReturnType<DynamicReader['readReplies']>>>();
  let pendingSignal: AbortSignal | undefined;
  const reader = createReader({
    readUps: async () => ({ status: 'success', data: [] }),
    readList: async () => ({ status: 'success', data: { items: [commentDynamic()], nextCursor: null } }),
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => ({
      status: 'success', data: { items: [comment(1, { replyCount: 25 })], nextCursor: null },
    }),
    readReplies: async input => {
      if (input.page === undefined) return { status: 'success', data: { items: replies(3), nextCursor: 'more' } };
      if (input.page === 1) return { status: 'success', data: pageBatch(25, 1) };
      pendingSignal = input.signal;
      return pending.promise;
    },
  });

  const router = await showApp(reader, '/');
  await screen.findByText('详情正文');
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(10));
  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(pendingSignal).toBeTruthy());

  await fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('list'));
  expect(pendingSignal?.aborted).toBe(true);

  // 主动再次进入是新的访问：回复区重新预览，不继承上次的展开与页码。
  await fireEvent.click(screen.getByRole('link', { name: '阅读全文 1001' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('detail'));
  const reopened = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(3));
  pending.resolve({ status: 'success', data: pageBatch(25, 2) });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(within(reopened).queryByRole('navigation', { name: '回复分页' })).toBeNull();
  expect(within(reopened).getByRole('button', { name: '展开回复' })).toBeTruthy();
  expect(scrolled.length).toBe(0);
});

it('读取器声明不提供回复时整块提示未归档且不发请求，来源计数未知仍读本地回复', async () => {
  const seen: ReplyRequest[] = [];
  const unarchived = detailReader({
    replies: 'not-archived',
    readReplies: async input => {
      seen.push(replySignal(input));
      return { status: 'success', data: { items: replies(1), nextCursor: null } };
    },
  });
  await showApp(unarchived, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  expect(within(commentItem(1)).getByText('回复尚未归档。')).toBeTruthy();
  expect(seen).toHaveLength(0);
  expect(within(commentItem(1)).queryByRole('list', { name: '回复列表' })).toBeNull();

  cleanup();
  const unknown = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      return { status: 'success', data: { items: replies(1), nextCursor: null } };
    },
  }, [comment(1, { replyCount: null })]);
  await showApp(unknown, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  // 未知计数不伪装成零：仍读取本地归档回复。
  expect(seen).toEqual([{ rootId: comment(1).id, limit: 3, page: undefined, cursor: undefined }]);
});

it('本地零条不被解释成来源没有回复，失败/未完成/未确认各自区分', async () => {
  const cases: [string, string][] = [
    ['pending', '回复尚未完成归档。'],
    ['failed', '回复最近归档失败。'],
    ['unconfirmed', '回复归档尚未确认完成。'],
    [undefined as never, '暂无回复'],
  ];
  for (const [attempt, expected] of cases) {
    const reader = detailReader({
      readReplies: async () => ({
        status: 'success',
        data: {
          items: [], nextCursor: null, sourceReplyCount: 25,
          ...(attempt === (undefined as never) ? { repliesLastAttempt: 'success' as const } : { repliesLastAttempt: attempt as never }),
        },
      }),
    });
    await showApp(reader, '/dynamics/1001');
    await screen.findByRole('region', { name: '评论区' });
    // 等最终空态落地，而不是加载中的临时提示。
    expect(await within(commentItem(1)).findByText(expected)).toBeTruthy();
    expect(within(commentItem(1)).queryByRole('button', { name: '展开回复' })).toBeNull();
    cleanup();
  }
});

it('取消后的迟到失败与异常不改写收起后的预览态', async () => {
  const pending = deferred<Awaited<ReturnType<DynamicReader['readReplies']>>>();
  const seen: ReplyRequest[] = [];
  const reader = detailReader({
    readReplies: async input => {
      seen.push(replySignal(input));
      if (input.page === undefined) return { status: 'success', data: { items: replies(3), nextCursor: 'more' } };
      if (input.page === 1) return { status: 'success', data: pageBatch(25, 1) };
      if (input.page === 2) return pending.promise;
      throw new Error('迟到的异常');
    },
  });

  await showApp(reader, '/dynamics/1001');
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));
  await fireEvent.click(within(region).getByRole('button', { name: '展开回复' }));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(10));
  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(seen.at(-1)!.page).toBe(2));
  await fireEvent.click(within(region).getByRole('button', { name: '收起' }));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(3));

  // 取消后迟到的失败结果与传输异常都不再显示错误，也不改动预览内容。
  pending.resolve({ status: 'error' });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(within(commentItem(1)).queryByRole('alert')).toBeNull();
  expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(3);
  expect(within(region).queryByRole('navigation', { name: '回复分页' })).toBeNull();
});

function locatePath(replyId: string, rootId = comment(1).id): string {
  return `/dynamics/1001/comments/${rootId}/replies/${replyId}/locate`;
}

const locateLongText = Array.from({ length: 7 }, (_value, line) =>
  `第七行边界 ${line + 1}：这是一段足够长的回复正文，用于验证定位后默认展开。`).join('\n');

function locatedItems(region: HTMLElement): HTMLElement[] {
  return within(region).getAllByRole('listitem').filter(item => item.getAttribute('data-located') === 'true');
}

it('宽屏精确入口只读目标所在页：展开并高亮该条，不先读预览也不渲染全部回复', async () => {
  const scrolled = recordScrollIntoView();
  const rootId = comment(1).id;
  const target = replies(25)[13]!;
  const located: { rootId: string; replyId: string }[] = [];
  const pageReads: ReplyRequest[] = [];
  const reader = locateRootReader({
    readReplies: async input => {
      pageReads.push(replySignal(input));
      return { status: 'success', data: pageBatch(25, input.page ?? 1) };
    },
    locateReply: async input => {
      located.push({ rootId: input.rootId, replyId: input.replyId });
      return {
        status: 'success',
        data: { ...pageBatch(25, 2), page: 2,
          items: pageBatch(25, 2).items.map(item =>
            item.id === target.id ? { ...item, text: locateLongText } : item) },
      };
    },
  });

  await showApp(reader, locatePath(target.id));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(replyList(1)).toHaveLength(1));

  // 只按目标身份读定位响应：既不先读 3 条预览，也不先读第 1 页。
  expect(located).toEqual([{ rootId, replyId: target.id }]);
  expect(pageReads).toEqual([]);
  const list = replyList(1)[0]!;
  const entries = within(list).getAllByRole('listitem');
  expect(entries).toHaveLength(10);
  expect(entries.map(item => item.dataset.readingId))
    .toEqual(replies(25).slice(10, 20).map(item => `reply:${rootId}:${item.id}`));
  // 只有目标一条被标记，且定位落在目标回复本身。
  expect(locatedItems(region).map(item => item.dataset.readingId)).toEqual([`reply:${rootId}:${target.id}`]);
  const highlighted = locatedItems(region)[0]!;
  expect(highlighted.getAttribute('aria-current')).toBe('true');
  expect(scrolled.at(-1)).toBe(highlighted);
  // 目标正文整段可读；折叠开关按真实行高判定，默认展开由浏览器用例断言。
  expect(highlighted.textContent).toContain('第七行边界 7');
  // 分页停在第 2 页，不回到第 1 页。
  expect(within(region).getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');

  // 定位后的翻页仍是原页内替换，不累计也不渲染全部。
  await fireEvent.click(within(region).getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(5));
  expect(pageReads.at(-1)).toEqual({ rootId, limit: 10, page: 3, cursor: undefined });
  expect(within(list).getAllByRole('listitem')[4]!.dataset.readingId).toBe(`reply:${rootId}:9025`);

  // 收起回到常规 3 条预览首屏：按需读取预览，不再停留在定位页。
  await fireEvent.click(within(region).getByRole('button', { name: '收起' }));
  await waitFor(() => expect(pageReads.filter(item => item.page === undefined)).toHaveLength(1));
  await waitFor(() => expect(within(replyList(1)[0]!).getAllByRole('listitem')).toHaveLength(3));
  expect(within(region).queryByRole('navigation', { name: '回复分页' })).toBeNull();
  expect(locatedItems(region)).toHaveLength(0);
});

it('宽屏精确入口：目标不存在时明确提示并可返回动态，不读取预览或页码', async () => {
  const pageReads: ReplyRequest[] = [];
  const reader = locateRootReader({
    readReplies: async input => {
      pageReads.push(replySignal(input));
      return { status: 'success', data: pageBatch(25, input.page ?? 1) };
    },
    locateReply: async () => ({ status: 'not-found' }),
  });

  const router = await showApp(reader, locatePath('9999'));
  const region = await screen.findByRole('region', { name: '评论区' });
  const replyRegion = () => within(commentItem(1)).getByRole('region', { name: '回复区' });
  await waitFor(() => expect(within(replyRegion()).getByRole('status').textContent)
    .toContain('不存在或未归档'));
  // 所属根评论仍在（上下文），但没有回复列表、没有高亮，也没有读页码模式。
  expect(within(region).getByRole('listitem')).toBeTruthy();
  expect(within(replyRegion()).queryByRole('list', { name: '回复列表' })).toBeNull();
  expect(locatedItems(region)).toHaveLength(0);
  expect(pageReads).toEqual([]);

  await fireEvent.click(within(replyRegion()).getByRole('button', { name: '返回动态' }));
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/dynamics/1001'));
});

it('宽屏精确入口：临时失败保留局部重试，重试成功后才展开并高亮目标', async () => {
  const rootId = comment(1).id;
  const target = replies(25)[13]!;
  const attempts: string[] = [];
  const reader = locateRootReader({
    readReplies: async input => ({ status: 'success', data: pageBatch(25, input.page ?? 1) }),
    locateReply: async input => {
      attempts.push(input.replyId);
      if (attempts.length === 1) return { status: 'error' };
      return { status: 'success', data: { ...pageBatch(25, 2), page: 2 } };
    },
  });

  await showApp(reader, locatePath(target.id));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getByRole('alert').textContent).toContain('读取失败'));
  expect(locatedItems(region)).toHaveLength(0);

  await fireEvent.click(within(region).getByRole('button', { name: '重试' }));
  await waitFor(() => expect(locatedItems(region)).toHaveLength(1));
  expect(locatedItems(region)[0]!.dataset.readingId).toBe(`reply:${rootId}:${target.id}`);
  expect(attempts).toEqual([target.id, target.id]);
});

it('宽屏精确入口：切换目标链接时迟到的前一次定位不覆盖当前目标', async () => {
  recordScrollIntoView();
  const rootId = comment(1).id;
  const first = replies(25)[13]!;
  const second = replies(25)[23]!;
  const pending = deferred<Awaited<ReturnType<DynamicReader['locateReply']>>>();
  const requested: string[] = [];
  const reader = locateRootReader({
    readReplies: async input => ({ status: 'success', data: pageBatch(25, input.page ?? 1) }),
    locateReply: async input => {
      requested.push(input.replyId);
      return input.replyId === first.id
        ? pending.promise
        : { status: 'success', data: { ...pageBatch(25, 3), page: 3 } };
    },
  });

  const router = await showApp(reader, locatePath(first.id));
  await waitFor(() => expect(requested).toEqual([first.id]));
  await router.push(locatePath(second.id));
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getByRole('button', { name: '3' }).getAttribute('aria-current'))
    .toBe('page'));

  pending.resolve({ status: 'success', data: { ...pageBatch(25, 2), page: 2 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(locatedItems(region).map(item => item.dataset.readingId)).toEqual([`reply:${rootId}:${second.id}`]);
  expect(within(region).getByRole('button', { name: '3' }).getAttribute('aria-current')).toBe('page');
  expect(within(region).queryByRole('alert')).toBeNull();
});
