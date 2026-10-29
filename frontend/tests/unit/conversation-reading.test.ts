import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/vue';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Comment, ConversationBatch, Dynamic, DynamicReader, Reply, ReplyBatch } from '../../src/data/contracts';
import { comment, commentDynamic } from '../fixtures/comments';
import { reply } from '../fixtures/replies';
import { createMockArchiveReader } from '../../src/mock/archiveReader';
import { showApp } from '../support/app';
import { createReader } from '../support/reader';
import { installFakeLayout, type FakeLayout } from '../support/layout';
import { installCompactViewport, removeCompactViewport } from '../support/viewport';

// 06：对话入口资格来自服务端投影，会话读取是独立只读子资源；mock 装配必须映射同一语义。

const signal = () => new AbortController().signal;

let layout: FakeLayout;
beforeEach(() => { layout = installFakeLayout(); });
afterEach(() => {
  cleanup();
  layout.restore();
  removeCompactViewport();
});

async function mockFixture() {
  const reader = createMockArchiveReader();
  const list = await reader.readList({ scope: { kind: 'all' }, limit: 10, signal: signal() });
  if (list.status !== 'success') throw new Error('mock 列表应成功');
  const dynamic: Dynamic = list.data.items[0]!;
  const comments = await reader.readComments({ dynamicId: dynamic.id, sort: 'latest', signal: signal() });
  if (comments.status !== 'success') throw new Error('mock 评论应成功');
  const root: Comment = comments.data.items[0]!;
  const page = async (reader: DynamicReader, number: number): Promise<ReplyBatch> => {
    const result = await reader.readReplies({
      dynamicId: dynamic.id, rootId: root.id, page: number, limit: 10, signal: signal(),
    });
    if (result.status !== 'success') throw new Error(`mock 页码 ${number} 应成功`);
    return result.data;
  };
  return { reader, dynamic, root, page };
}

it('mock 页码读取带对话投影：A→B 与分支共享起点，缺祖先标记不完整，独立发言无投影', async () => {
  const { reader, dynamic, root, page } = await mockFixture();
  const all = [...(await page(reader, 1)).items, ...(await page(reader, 2)).items,
    ...(await page(reader, 3)).items];
  const projection = (index: number) => all[index]!.conversation;

  // 单条没有可确认关系：即使正文自称“回复”也不构成对话。
  expect(all[0]!.conversation).toBeNull();
  // A→B 与旁支：起点是 A，B／C 与跨页成员共享同一段计数。
  const start = all[1]!;
  const expected = { startId: start.id, count: 4, incomplete: false };
  expect(projection(1)).toEqual(expected);
  expect(projection(2)).toEqual(expected);
  expect(projection(3)).toEqual(expected);
  expect(projection(12)).toEqual(expected);
  // 父级未保存：起点止步、两条可确认并标记上下文不完整；起点本身也带同一投影。
  expect(projection(6)).toEqual({ startId: all[6]!.id, count: 2, incomplete: true });
  expect(projection(7)).toEqual({ startId: all[6]!.id, count: 2, incomplete: true });
  // 其余独立发言与同名作者、相同正文前缀都不串楼。
  for (const index of [4, 5, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]) {
    expect(projection(index), String(index)).toBeNull();
  }
  // cursor 预览不带投影：字段缺失即不推断入口。
  const preview = await reader.readReplies({ dynamicId: dynamic.id, rootId: root.id, limit: 3, signal: signal() });
  if (preview.status !== 'success') throw new Error('mock 预览应成功');
  expect(preview.data.items.every(item => item.conversation == null)).toBe(true);
});

it('mock 会话读取：一次返回整段，身份回显、缺祖先标记，不存在与取消分开', async () => {
  const { reader, dynamic, root, page } = await mockFixture();
  const all = [...(await page(reader, 1)).items, ...(await page(reader, 2)).items];
  const entry = all[12]!;
  const read = (input: { replyId: string }) => reader.readConversation({
    dynamicId: dynamic.id, rootId: root.id, replyId: input.replyId, signal: signal(),
  });

  const whole = await read({ replyId: entry.id });
  if (whole.status !== 'success') throw new Error('会话读取应成功');
  expect(whole.data).toMatchObject({
    dynamicId: dynamic.id, rootId: root.id, replyId: entry.id, startId: all[1]!.id,
    incomplete: false, count: 4, nextCursor: null,
  });
  // 整段一次给全：没有页码，也不截成每页 10 条。
  expect(whole.data.items.map(item => item.id)).toEqual([all[1]!.id, all[2]!.id, all[3]!.id, entry.id]);

  const partial = await read({ replyId: all[7]!.id });
  if (partial.status !== 'success') throw new Error('缺祖先会话应可读');
  expect(partial.data).toMatchObject({ startId: all[6]!.id, incomplete: true, count: 2 });
  expect(partial.data.items.map(item => item.id)).toEqual([all[6]!.id, all[7]!.id]);

  expect(await read({ replyId: '999999' })).toEqual({ status: 'not-found' });
  expect(await reader.readConversation({
    dynamicId: dynamic.id, rootId: '999999', replyId: entry.id, signal: signal(),
  })).toEqual({ status: 'not-found' });
  const aborted = new AbortController();
  aborted.abort();
  expect(await reader.readConversation({
    dynamicId: dynamic.id, rootId: root.id, replyId: entry.id, signal: aborted.signal,
  })).toEqual({ status: 'cancelled' });
});

// ---- 手机会话页与入口 ----

const dynamicId = '1001';
const rootId = comment(1).id;

function replyWith(index: number, overrides: Partial<Reply> = {}): Reply {
  return reply(index, overrides);
}

/** 一段 4 条对话：9001 起点、9002/9003 分支、9012 在后续页；另有独立 9005 与缺祖先 9021→9022。 */
function conversationFixture(): Reply[] {
  const start = replyWith(1, { text: '起点发言' });
  const projection = { startId: start.id, count: 4, incomplete: false };
  return [
    { ...start, conversation: projection },
    replyWith(2, { text: '分支甲', parentId: start.id, conversation: projection }),
    replyWith(3, { text: '分支乙', parentId: start.id, conversation: projection }),
    replyWith(5, { text: '无关发言', conversation: null }),
    replyWith(12, { text: '后续页成员', parentId: start.id, conversation: projection }),
    replyWith(21, { text: '缺祖先起点', conversation: { startId: replyWith(21).id, count: 2, incomplete: true } }),
    replyWith(22, { text: '缺祖先成员', parentId: replyWith(21).id,
      conversation: { startId: replyWith(21).id, count: 2, incomplete: true } }),
  ];
}

function threadBatch(items: Reply[]): ReplyBatch {
  return {
    items, nextCursor: null, count: 25, localReplyCount: 25, sourceReplyCount: 25, root: comment(1),
  };
}

/** 整段会话夹具：`count` 与条目数一致，没有页码。 */
function conversation(overrides: Partial<ConversationBatch> = {}): ConversationBatch {
  return {
    dynamicId, rootId, replyId: reply(1).id, startId: reply(1).id, incomplete: false,
    count: 3, nextCursor: null,
    items: [replyWith(1), replyWith(2, { parentId: reply(1).id }), replyWith(3, { parentId: reply(1).id })],
    ...overrides,
  };
}

/** 14 条同段对话：超过旧分页的 10 条上限，用来证明整段不被隐式截断。 */
function longConversation(): Reply[] {
  return Array.from({ length: 14 }, (_value, index) => replyWith(index + 1, {
    parentId: index === 0 ? null : reply(1).id,
    text: `对话第 ${index + 1} 条`,
  }));
}

it('会话页一次整段读取：11 条以上全部呈现、无分页控件，并只标记入口回复一次', async () => {
  installCompactViewport(true);
  const seen: string[] = [];
  const items = longConversation();
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async () => ({ status: 'success', data: threadBatch(conversationFixture()) }),
    readConversation: async input => {
      seen.push(input.replyId);
      return { status: 'success', data: conversation({ replyId: input.replyId, count: items.length, items }) };
    },
  });

  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(2).id}/conversation`);

  const list = await screen.findByRole('list', { name: '对话内容' });
  // 超过旧分页上限也一次全给：14 条按时间正序，不被隐式截成 10 条。
  expect(within(list).getAllByRole('listitem').map(item => item.dataset.readingId))
    .toEqual(items.map(item => `reply:${rootId}:${item.id}`));
  expect(screen.getByText('共 14 条')).toBeTruthy();
  // 一级评论不在会话正文里重复；页头只有返回控件，没有排序控件、分页控件与重复标题。
  expect(screen.queryByRole('article', { name: '被回复的评论' })).toBeNull();
  const back = screen.getByRole('button', { name: '会话列表，返回评论详情' });
  expect(back.textContent).toBe('‹ 会话列表');
  // 无障碍名包含可见标签（Label in Name），并额外说明返回到评论详情。
  expect(back.textContent?.trim()).toContain('会话列表');
  expect(back.getAttribute('aria-label')).toContain('会话列表');
  expect(screen.queryByText('按时间')).toBeNull();
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.queryByRole('navigation', { name: '回复分页' })).toBeNull();
  expect(screen.queryByRole('button', { name: '下一页' })).toBeNull();
  // 标记唯一且落在入口回复：只有一条“刚才查看”。
  const marked = list.querySelectorAll('[data-conversation-entry="true"]');
  expect(marked).toHaveLength(1);
  expect(marked[0]!.getAttribute('data-reading-id')).toBe(`reply:${rootId}:${reply(2).id}`);
  expect(within(marked[0] as HTMLElement).getByText('刚才查看')).toBeTruthy();
  expect(screen.getAllByText('刚才查看')).toHaveLength(1);
  // 一次请求读完整段：不循环翻页，请求也不带页码或批量。
  expect(seen).toEqual([reply(2).id]);
});

it('新进入把入口回复放到视口中央：首尾按需补留白，用户滚动后不再抢回', async () => {
  installCompactViewport(true);
  const items = longConversation();
  const read = async (replyId: string) => ({
    status: 'success' as const, data: conversation({ replyId, count: items.length, items }),
  });
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async () => ({ status: 'success', data: threadBatch(conversationFixture()) }),
    readConversation: async input => read(input.replyId),
  });

  // 第 2 条：锚点文档位置 400、高 260，视口 768 → 居中位置 400 - (768 - 260)/2 = 146。
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(2).id}/conversation`);
  await screen.findByRole('list', { name: '对话内容' });
  await waitFor(() => expect(layout.scrollY()).toBe(146));
  // 条目本来就在可滚动范围内：不补留白。
  expect((screen.getByRole('list', { name: '对话内容' }) as HTMLElement).style.paddingTop).toBe('0px');

  // 首条：居中位置为负，按需补 154 + 8 的顶部留白，然后停在 8 而不是被夹回 0。
  cleanup();
  layout.setScrollY(0);
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(1).id}/conversation`);
  const first = await screen.findByRole('list', { name: '对话内容' });
  await waitFor(() => expect(first.style.paddingTop).toBe('162px'));
  await waitFor(() => expect(layout.scrollY()).toBe(8));

  // 用户先滚动：迟到的一次性居中让位，不再把页面拉回入口。
  cleanup();
  layout.setScrollY(0);
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(5).id}/conversation`);
  await screen.findByRole('list', { name: '对话内容' });
  await fireEvent.scroll(window, { target: { scrollY: 0 } });
  window.dispatchEvent(new Event('wheel'));
  layout.setScrollY(300);
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(layout.scrollY()).toBe(300);
  // 会话页不提供“收起”这类楼中楼动作。
  expect(screen.queryByRole('button', { name: '收起' })).toBeNull();
});

it('缺失祖先只提示可确认部分，暂时失败可局部重试，目标不存在与失败分开', async () => {
  installCompactViewport(true);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async () => ({ status: 'success', data: threadBatch(conversationFixture()) }),
    readConversation: async () => ({ status: 'success', data: conversation({
      incomplete: true, count: 2,
      items: [replyWith(21, { text: '缺祖先起点' }),
        replyWith(22, { parentId: reply(21).id, text: '缺祖先成员' })],
    }) }),
  });
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(22).id}/conversation`);
  expect(await screen.findByText('部分上下文暂不可用')).toBeTruthy();
  const list = screen.getByRole('list', { name: '对话内容' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  // 不伪造缺失作者或内容：条目只展示本地已有的两段正文。
  expect(list.textContent).toContain('缺祖先起点');
  expect(list.textContent).toContain('缺祖先成员');

  cleanup();
  let failures = 1;
  let reads = 0;
  const flaky = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async () => ({ status: 'success', data: threadBatch(conversationFixture()) }),
    readConversation: async () => {
      reads += 1;
      if (failures > 0) {
        failures -= 1;
        return { status: 'error' };
      }
      return { status: 'success', data: conversation() };
    },
  });
  await showApp(flaky, `/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(2).id}/conversation`);
  expect((await screen.findByRole('alert')).textContent).toContain('会话读取失败，请重试。');
  await fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByRole('list', { name: '对话内容' })).toBeTruthy();
  expect(reads).toBe(2);

  cleanup();
  const missing = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async () => ({ status: 'success', data: threadBatch(conversationFixture()) }),
    readConversation: async () => ({ status: 'not-found' }),
  });
  await showApp(missing, `/dynamics/${dynamicId}/comments/${rootId}/replies/9999/conversation`);
  const absent = await screen.findByRole('region', { name: '会话结果' });
  expect(absent.textContent).toContain('这条对话不存在或未保存');
  await fireEvent.click(within(absent).getByRole('button', { name: '返回评论详情' }));
  await waitFor(() => expect(screen.getByRole('list', { name: '相关回复' })).toBeTruthy());
});

it('楼中楼条目只在手机视图显示查看对话，并回到那一次访问；桌面不新增会话入口', async () => {
  installCompactViewport(true);
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async () => ({ status: 'success', data: threadBatch(conversationFixture()) }),
    readConversation: async input => ({
      status: 'success', data: conversation({ replyId: input.replyId }),
    }),
  });
  const router = await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  const list = await screen.findByRole('list', { name: '相关回复' });
  const entries = within(list).getAllByRole('listitem');
  // 门槛是“至少两条且不是起点”：单条无关发言与对话起点都没有入口。
  const withEntry = entries.filter(item => within(item).queryByRole('button', { name: '查看对话' }));
  expect(withEntry.map(item => item.dataset.readingId)).toEqual(
    [2, 3, 12, 22].map(index => `reply:${rootId}:${reply(index).id}`));

  await fireEvent.click(within(list).getAllByRole('button', { name: '查看对话' })[0]!);
  await waitFor(() => expect(router.currentRoute.value.name).toBe('conversation'));
  expect(router.currentRoute.value.path)
    .toBe(`/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(2).id}/conversation`);
  expect(await screen.findByRole('list', { name: '对话内容' })).toBeTruthy();

  await fireEvent.click(screen.getByRole('button', { name: '会话列表，返回评论详情' }));
  await waitFor(() => expect(screen.getByRole('list', { name: '相关回复' })).toBeTruthy());
  expect(router.currentRoute.value.name).toBe('thread');

  // 桌面视图不提供会话入口：同一批数据一条都不渲染。
  cleanup();
  removeCompactViewport();
  await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}`);
  const wide = await screen.findByRole('list', { name: '相关回复' });
  expect(within(wide).queryByRole('button', { name: '查看对话' })).toBeNull();
});

it('直达会话页没有来源时返回所属回复详情，不留在不可用的会话地址', async () => {
  const reader = createReader({
    readDetail: async () => ({ status: 'success', data: commentDynamic() }),
    readReplies: async () => ({ status: 'success', data: threadBatch(conversationFixture()) }),
    readConversation: async () => ({ status: 'success', data: conversation() }),
  });
  const router = await showApp(reader, `/dynamics/${dynamicId}/comments/${rootId}/replies/${reply(2).id}/conversation`);
  await screen.findByRole('list', { name: '对话内容' });
  await fireEvent.click(screen.getByRole('button', { name: '会话列表，返回评论详情' }));
  await waitFor(() => expect(router.currentRoute.value.name).toBe('thread'));
  expect(router.currentRoute.value.path).toBe(`/dynamics/${dynamicId}/comments/${rootId}`);
});
