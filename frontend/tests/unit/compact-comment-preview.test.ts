import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DynamicReader } from '../../src/data/contracts';
import { comment, commentDynamic } from '../fixtures/comments';
import { reply, replies } from '../fixtures/replies';
import { createReader } from '../support/reader';
import { showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { installCompactViewport, removeCompactViewport } from '../support/viewport';

let layout: FakeLayout;
beforeEach(() => {
  layout = installFakeLayout();
  installCompactViewport(true);
});
afterEach(() => {
  cleanup();
  layout.restore();
  removeCompactViewport();
});

const upAuthor = { id: '123', nickname: '动态作者', avatarUrl: null };
const nestedTarget = { id: '7100', nickname: '阿蓝', avatarUrl: null };

interface ReplyRequest {
  limit: number;
  page: number | undefined;
  cursor: string | null | undefined;
}

/** 详情 + 一级评论的公共读取；窄屏入口用例不应发起任何回复读取。 */
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

/** 该动态作者在此楼最早的一条回复：来源契约已有，预览只消费它。 */
function upReply(): ReturnType<typeof reply> {
  return reply(1, {
    author: upAuthor,
    replyTo: nestedTarget,
    text: '回复 @阿蓝: UP 的最早回复',
  });
}

it('窄屏正来源回复数用 UP 摘要进入独立楼中楼，不读取内联回复', async () => {
  const seen: ReplyRequest[] = [];
  const reader = detailReader({
    readReplies: async input => {
      seen.push({ limit: input.limit, page: input.page, cursor: input.cursor });
      return { status: 'success', data: { items: replies(10), nextCursor: null, count: 25 } };
    },
  }, [comment(1, { replyCount: 25, upReply: upReply() })]);

  const router = await showApp(reader, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  const item = commentItem(1);

  // 摘要展示该动态作者的回复、UP 标识与条件化回复目标，正文渲染期剥离重复来源前缀。
  await waitFor(() => expect(within(item).getAllByText('UP主')).toHaveLength(1));
  expect(item.textContent).toContain('UP 的最早回复');
  expect(item.textContent).toContain('回复 阿蓝:');
  expect(item.textContent).not.toContain('回复 @阿蓝');
  // 窄屏不建内联回复区，也不为此发起 cursor 读取。
  expect(within(item).queryByRole('list', { name: '回复列表' })).toBeNull();
  expect(seen).toEqual([]);

  const entry = within(item).getByRole('button', { name: 'UP主等人 共25条回复' });
  await fireEvent.click(entry);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  expect(router.currentRoute.value.path).toBe(`/dynamics/1001/comments/${comment(1).id}`);
});

it('无作者摘要时只显示数量入口，本地零条仍可进入独立楼中楼', async () => {
  const seen: ReplyRequest[] = [];
  const root = comment(1, { replyCount: 8, upReply: null });
  const reader = detailReader({
    readReplies: async input => {
      seen.push({ limit: input.limit, page: input.page, cursor: input.cursor });
      return {
        status: 'success',
        data: {
          items: [], nextCursor: null, count: 0, localReplyCount: 0,
          sourceReplyCount: 8, root,
        },
      };
    },
  }, [root]);

  const router = await showApp(reader, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  const entry = await within(commentItem(1)).findByRole('button', { name: '共8条回复' });
  expect(within(commentItem(1)).queryByText('UP主等人')).toBeNull();

  await fireEvent.click(entry);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  // 页头按来源数，正文按本地页读取：来源正、本地零也不掩饰。
  expect(await screen.findByText('相关回复共8条')).toBeTruthy();
  expect(await screen.findByText('暂无回复')).toBeTruthy();
  expect(seen.at(-1)).toEqual({ limit: 10, page: 1, cursor: undefined });
});

it('来源回复数为零或未知时不显示预览与入口', async () => {
  const seen: ReplyRequest[] = [];
  const reader = detailReader({
    readReplies: async input => {
      seen.push({ limit: input.limit, page: input.page, cursor: input.cursor });
      return { status: 'success', data: { items: replies(2), nextCursor: null } };
    },
  }, [
    comment(1, { replyCount: 0, upReply: upReply() }),
    comment(2, { replyCount: null, upReply: upReply() }),
  ]);

  await showApp(reader, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  await waitFor(() => expect(commentItem(1).textContent).toContain('一级评论 1'));

  for (const index of [1, 2]) {
    const item = commentItem(index);
    expect(within(item).queryByRole('button', { name: /条回复/ })).toBeNull();
    expect(within(item).queryByRole('list', { name: '回复列表' })).toBeNull();
  }
  // 未知本地回复数也不被当成来源有回复；窄屏不发任何回复读取。
  expect(seen).toEqual([]);
});

it('无法判定视口时按宽屏渲染内联回复区，不出窄屏入口', async () => {
  removeCompactViewport();
  const seen: ReplyRequest[] = [];
  const reader = detailReader({
    readReplies: async input => {
      seen.push({ limit: input.limit, page: input.page, cursor: input.cursor });
      return { status: 'success', data: { items: replies(3), nextCursor: 'more' } };
    },
  });

  await showApp(reader, '/dynamics/1001');
  await screen.findByRole('region', { name: '评论区' });
  const list = await within(commentItem(1)).findByRole('list', { name: '回复列表' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  expect(seen).toEqual([{ limit: 3, page: undefined, cursor: undefined }]);
  expect(within(commentItem(1)).queryByRole('button', { name: /条回复/ })).toBeNull();
});
