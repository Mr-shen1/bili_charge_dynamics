import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Comment, ReplyBatch } from '../../src/data/contracts';
import { comment, commentDynamic, comments } from '../fixtures/comments';
import { replies } from '../fixtures/replies';
import { createReader } from '../support/reader';
import { settle, showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { installCompactViewport, removeCompactViewport } from '../support/viewport';

// 精确入口（一级评论定位、楼中楼回复定位）也是原详情/楼中楼阅读的一次访问：
// 返回、历史恢复必须沿用原快照与来源关系，只有真正的新访问才重新主动定位。

const dynamicId = '1001';

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
  removeCompactViewport();
});

interface ReplyPageRequest {
  rootId: string;
  limit: number;
  page: number | undefined;
  cursor: string | null | undefined;
}

function pageBatch(total: number, page: number, root: Comment): ReplyBatch {
  const offset = (page - 1) * 10;
  return {
    items: replies(total).slice(offset, offset + 10),
    nextCursor: null,
    count: total,
    localReplyCount: total,
    sourceReplyCount: total,
    root,
  };
}

/** jsdom 没有 scrollIntoView：记录被定位的元素，验证没有重复的主动定位。 */
function recordScrollIntoView(): Element[] {
  const scrolled: Element[] = [];
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value(this: Element) { scrolled.push(this); },
  });
  return scrolled;
}

function locatedItems(): HTMLElement[] {
  return screen.getAllByRole('region', { name: '评论区' })
    .flatMap(region => within(region).queryAllByRole('listitem'))
    .filter(item => item.getAttribute('data-located') === 'true');
}

it('窄屏精确根入口进入楼中楼后返回：恢复已读批次与位置，不重复主动定位', async () => {
  installCompactViewport(true);
  const scrolled = recordScrollIntoView();
  const all = comments(49);
  const root = { ...all[24]!, text: '精确定位到的根评论', replyCount: 25 };
  const locatedBatch = [root, ...all.slice(25, 44)];
  const located: string[] = [];
  const commentReads: (string | null | undefined)[] = [];
  const replyReads: ReplyPageRequest[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    locateComment: async input => {
      located.push(input.rootId);
      return { status: 'success', data: { items: locatedBatch, nextCursor: 'located-20' } };
    },
    readComments: async input => {
      commentReads.push(input.cursor);
      return { status: 'success', data: { items: all.slice(44, 49), nextCursor: null } };
    },
    readReplies: async input => {
      replyReads.push({ rootId: input.rootId, limit: input.limit, page: input.page, cursor: input.cursor });
      return { status: 'success', data: pageBatch(25, input.page ?? 1, root) };
    },
  });

  const router = await showApp(reader, `/dynamics/${dynamicId}/comments/${root.id}/locate`);
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  expect(located).toEqual([root.id]);
  expect(locatedItems()).toHaveLength(1);
  const locatesBefore = scrolled.length;

  // 定位后继续阅读：追加下一批，并把视口移到批次中段。
  await fireEvent.click(within(region).getByRole('button', { name: '加载更多评论' }));
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(25));
  expect(commentReads).toEqual(['located-20']);
  layout.setScrollY(500);

  // 查看楼中楼：精确定位访问是楼中楼的详情来源，返回应回到这一次访问。
  await fireEvent.click(within(region).getAllByRole('button', { name: /条回复/ })[0]!);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  expect(await screen.findByText('相关回复共25条')).toBeTruthy();
  expect(replyReads.at(-1)!.page).toBe(1);

  await fireEvent.click(screen.getByRole('button', { name: '评论详情，返回动态详情' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('comment-locate'));

  const restored = await screen.findByRole('region', { name: '评论区' });
  // 已读批次、定位高亮与位置都在；没有重新请求定位端点，也没有再次主动定位。
  expect(within(restored).getAllByRole('listitem')).toHaveLength(25);
  expect(located).toEqual([root.id]);
  expect(commentReads).toEqual(['located-20']);
  expect(locatedItems()).toHaveLength(1);
  expect(scrolled.length).toBe(locatesBefore);
  await waitFor(() => expect(layout.scrollY()).toBe(500));
});

it('历史返回楼中楼回复精确访问：回复页、高亮与位置都在，且不再重新定位', async () => {
  const scrolled = recordScrollIntoView();
  const root = comment(1, { text: '被回复的根评论', replyCount: 25 });
  const target = replies(25)[13]!;
  const located: string[] = [];
  const pageReads: number[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readComments: async () => ({ status: 'success', data: { items: [root], nextCursor: null } }),
    locateComment: async () => ({ status: 'success', data: { items: [root], nextCursor: null } }),
    readReplies: async input => {
      if (input.page !== undefined) pageReads.push(input.page);
      return { status: 'success', data: pageBatch(25, input.page ?? 1, root) };
    },
    locateReply: async input => {
      located.push(input.replyId);
      return {
        status: 'success',
        data: { ...pageBatch(25, 2, root), page: 2 },
      };
    },
  });

  const locatePath = `/dynamics/${dynamicId}/comments/${root.id}/replies/${target.id}/locate`;
  const router = await showApp(reader, locatePath);
  const list = await screen.findByRole('list', { name: '回复列表' });
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(10));
  expect(located).toEqual([target.id]);
  // 目标停在第 2 页：定位读取不先读第 1 页。
  expect(pageReads).toEqual([]);
  const locatesBefore = scrolled.length;
  layout.setScrollY(1200);
  await settle();

  // 离开这一访问后再从历史返回：恢复到它自己的阅读状态，不重新执行主动定位。
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  await settle();
  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('reply-locate'));

  const restoredList = await screen.findByRole('list', { name: '回复列表' });
  await waitFor(() => expect(within(restoredList).getAllByRole('listitem')).toHaveLength(10));
  expect(located).toEqual([target.id]);
  // 恢复按保存页码重读，不再按目标身份重新定位。
  expect(pageReads).toEqual([2]);
  expect(locatedItems()[0]!.getAttribute('data-reading-id')).toBe(`reply:${root.id}:${target.id}`);
  const pager = screen.getByRole('navigation', { name: '回复分页' });
  expect(within(pager).getByRole('button', { name: '2' }).getAttribute('aria-current')).toBe('page');
  expect(scrolled.length).toBe(locatesBefore);
  await waitFor(() => expect(layout.scrollY()).toBe(1200));
});

it('同一动态的两个精确访问各存快照：前进后退分别恢复自己的目标批次与位置', async () => {
  recordScrollIntoView();
  const all = comments(45);
  const first = { ...all[24]!, text: '第一个精确目标', replyCount: 0 };
  const second = { ...all[29]!, text: '第二个精确目标', replyCount: 0 };
  const located: string[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    locateComment: async input => {
      located.push(input.rootId);
      const index = all.findIndex(item => item.id === input.rootId);
      return { status: 'success', data: { items: all.slice(index, index + 20), nextCursor: null } };
    },
  });

  const firstPath = `/dynamics/${dynamicId}/comments/${first.id}/locate`;
  const secondPath = `/dynamics/${dynamicId}/comments/${second.id}/locate`;
  const router = await showApp(reader, firstPath);
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  layout.setScrollY(300);
  await settle();

  await router.push(secondPath);
  await waitFor(() => expect(located).toEqual([first.id, second.id]));
  const secondRegion = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(secondRegion).getAllByRole('listitem')[0]!.getAttribute('data-reading-id'))
    .toBe(`comment:${second.id}`));
  layout.setScrollY(900);
  await settle();

  await router.go(-1);
  await waitFor(() => expect(router.currentRoute.value.fullPath).toBe(firstPath));
  const restoredFirst = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(restoredFirst).getAllByRole('listitem')[0]!.getAttribute('data-reading-id'))
    .toBe(`comment:${first.id}`));
  expect(located).toEqual([first.id, second.id]);
  await waitFor(() => expect(layout.scrollY()).toBe(300));

  await router.go(1);
  await waitFor(() => expect(router.currentRoute.value.fullPath).toBe(secondPath));
  const restoredSecond = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(restoredSecond).getAllByRole('listitem')[0]!.getAttribute('data-reading-id'))
    .toBe(`comment:${second.id}`));
  expect(located).toEqual([first.id, second.id]);
  await waitFor(() => expect(layout.scrollY()).toBe(900));
});

it('同一条精确链接的新访问不复用上一次访问的定位批次与位置', async () => {
  recordScrollIntoView();
  const all = comments(45);
  const root = { ...all[24]!, text: '精确定位到的根评论', replyCount: 0 };
  const located: string[] = [];
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    locateComment: async input => {
      located.push(input.rootId);
      return { status: 'success', data: { items: [root, ...all.slice(25, 44)], nextCursor: null } };
    },
  });
  const locatePath = `/dynamics/${dynamicId}/comments/${root.id}/locate`;

  const router = await showApp(reader, locatePath);
  const region = await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(region).getAllByRole('listitem')).toHaveLength(20));
  layout.setScrollY(600);
  await settle();

  // 从首页重新进入同一条链接：这是一次新访问，必须重新按 URL 主动定位。
  await router.push('/');
  await waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
  await settle();
  await router.push(locatePath);
  await waitFor(() => expect(located).toEqual([root.id, root.id]));
  const fresh = screen.getByRole('region', { name: '评论区' });
  await waitFor(() => expect(within(fresh).getAllByRole('listitem')[0]!.getAttribute('data-located')).toBe('true'));
  await waitFor(() => expect(layout.scrollY()).toBe(0));
});
