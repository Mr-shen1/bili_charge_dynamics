import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ReplyBatch } from '../../src/data/contracts';
import { comment, commentDynamic } from '../fixtures/comments';
import { reply } from '../fixtures/replies';
import { createReader } from '../support/reader';
import { showApp } from '../support/app';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { removeCompactViewport } from '../support/viewport';

/**
 * 桌面「查看对话」：弹窗承载同一份会话内容，不跳路由、不丢详情页状态。
 * 定位与滚动在真实浏览器里由 e2e 覆盖，这里只当作息流与标记的契约测试。
 */

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
  removeCompactViewport();
});

function commentItem(index = 1): HTMLElement {
  const items = screen.getAllByRole('listitem');
  return items[index - 1]!;
}

function pageBatch(): ReplyBatch {
  const items = [
    reply(1, { conversation: { startId: '9001', count: 3, incomplete: false } }),
    reply(2, { conversation: { startId: '9001', count: 3, incomplete: false } }),
    reply(3),
  ];
  return { items, nextCursor: 'more', sourceReplyCount: 3, localReplyCount: 3, count: 3 };
}

function conversationItems() {
  return [
    reply(1, { text: '对话起点' }),
    reply(2, { text: '刚才看的那条' }),
    reply(3, { text: '后来的回复' }),
  ];
}

function reader() {
  let conversationReads = 0;
  return {
    reads: () => conversationReads,
    reader: createReader({
      readDetail: async () => ({ status: 'success', data: commentDynamic() }),
      readComments: async () => ({ status: 'success', data: { items: [comment(1, { replyCount: 3 })], nextCursor: null } }),
      readReplies: async () => ({ status: 'success', data: pageBatch() }),
      readConversation: async input => {
        conversationReads += 1;
        return {
          status: 'success',
          data: {
            dynamicId: '1001', rootId: comment(1).id, replyId: input.replyId, startId: '9001',
            incomplete: false, count: 3, nextCursor: null, items: conversationItems(),
          },
        };
      },
    }),
  };
}

async function openDialog() {
  await showApp(reader().reader, '/dynamics/1001');
  await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0));
  const section = within(commentItem(1)).getByRole('region', { name: '回复区' });
  await fireEvent.click(within(section).getByRole('button', { name: '展开回复' }));
  const entry = await within(commentItem(1)).findByRole('button', { name: '查看对话' });
  await fireEvent.click(entry);
  return { dialog: await screen.findByRole('dialog'), entry };
}

it('桌面点「查看对话」在弹窗里读整段对话：不跳路由，入口标记唯一', async () => {
  const app = reader();
  const router = await showApp(app.reader, '/dynamics/1001');
  await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0));
  const section = within(commentItem(1)).getByRole('region', { name: '回复区' });
  await fireEvent.click(within(section).getByRole('button', { name: '展开回复' }));
  const entry = await within(commentItem(1)).findByRole('button', { name: '查看对话' });
  await fireEvent.click(entry);

  const dialog = await screen.findByRole('dialog');
  expect(router.currentRoute.value.fullPath).toBe('/dynamics/1001');
  const list = await within(dialog).findByRole('list', { name: '对话内容' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  expect(within(dialog).getByText('共 3 条')).toBeTruthy();
  // 入口标记唯一且就是刚才点的那条。
  expect(within(list).getAllByText('刚才查看')).toHaveLength(1);
  expect(list.querySelector('[data-conversation-entry="true"]')?.getAttribute('data-reading-id'))
    .toBe(`reply:${comment(1).id}:${reply(2).id}`);
  expect(app.reads()).toBe(1);
});

it('关闭弹窗后详情页仍是展开的那一楼，页码与内容不退', async () => {
  const { dialog } = await openDialog();
  const closeButton = within(dialog).getByRole('button', { name: 'Close this dialog' });
  expect(closeButton).toBeTruthy();
  await fireEvent.click(closeButton!);

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // 详情页没被卸载：回复区仍是展开的第 1 页，翻页与展开状态都在。
  expect(within(commentItem(1)).getByRole('list', { name: '回复列表' })).toBeTruthy();
  expect(within(commentItem(1)).getByRole('button', { name: '收起' })).toBeTruthy();
  // 焦点归还依赖真实浏览器的弹窗关闭时序，由 e2e 断言（见 conversation-dialog.spec.ts）。
});
