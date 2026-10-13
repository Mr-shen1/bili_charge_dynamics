import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router';
import { expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import type { CommentBatch, DynamicReader, ReadResult, ReplyBatch } from '../src/data/contracts';
import { createControlledReader } from '../src/dev/controlledReader';

const creator = { id: 'up', nickname: '纸飞机', avatarUrl: null };
const dynamic = { id: 'd', author: creator, publishedAt: null, text: '详情正文', commentCount: 70 };
const comments = Array.from({ length: 45 }, (_, i) => ({ id: `c-${String(i).padStart(2, '0')}`, author: creator,
  publishedAt: null, text: `讨论 ${i}`, likeCount: i, replyCount: i === 44 ? 25 : 0 }));
const replies = Array.from({ length: 25 }, (_, i) => ({ id: `r-${String(i).padStart(2, '0')}`, author: creator,
  publishedAt: null, text: `答复 ${i}`, likeCount: i, replyTo: null }));
function baseReader() {
  return createMockReader({ creator, dynamics: [dynamic], comments: { d: comments }, replies: { d: { 'c-44': replies } } });
}
function HistoryControls() {
  const navigate = useNavigate();
  return <><button onClick={() => void navigate(-1)}>历史后退</button>
    <button onClick={() => void navigate(1)}>历史前进</button>
    <button onClick={() => void navigate('/')}>新列表访问</button></>;
}
function show(reader: DynamicReader) {
  render(<MemoryRouter><HistoryControls /><App reader={reader} /></MemoryRouter>);
}
function deferred<T>() {
  let resolve!: (value: ReadResult<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ReadResult<T>>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('link', { name: '阅读全文 d' }));
  return screen.findByRole('region', { name: '评论区' });
}

it('历史返回恢复该次评论排序、已读顺序和下一批，而非从首批重新开始', async () => {
  const user = userEvent.setup();
  show(baseReader());
  let area = await open(user);
  await user.click(within(area).getByRole('button', { name: '最新' }));
  await within(area).findByText('讨论 0');
  await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(40);
  await user.click(screen.getByRole('button', { name: '返回列表' }));
  await screen.findByRole('link', { name: '阅读全文 d' });
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  area = await screen.findByRole('region', { name: '评论区' });
  expect(within(area).getByRole('button', { name: '最新' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(area).getAllByRole('listitem')).toHaveLength(40);
  await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
  expect(within(area).getAllByRole('list', { name: '一级评论' })[0]?.children).toHaveLength(45);
  expect(within(area).getByText('评论已加载完毕')).toBeVisible();
});

it('回复展开、已读范围和下一批在历史返回后保留，收起再离开仍可展开缓存', async () => {
  const user = userEvent.setup();
  show(baseReader());
  await open(user);
  let repliesArea = await screen.findByRole('region', { name: '回复区 c-44' });
  await within(repliesArea).findByText('答复 0');
  await user.click(within(repliesArea).getByRole('button', { name: '展开回复' }));
  await within(repliesArea).findByText('答复 12');
  await user.click(screen.getByRole('button', { name: '返回列表' }));
  await screen.findByRole('link', { name: '阅读全文 d' });
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  repliesArea = await screen.findByRole('region', { name: '回复区 c-44' });
  expect(within(repliesArea).getByText('答复 12')).toBeVisible();
  await user.click(within(repliesArea).getByRole('button', { name: '加载更多回复' }));
  expect(within(repliesArea).getAllByRole('listitem')).toHaveLength(23);
  await user.click(within(repliesArea).getByRole('button', { name: '收起回复' }));
  await user.click(screen.getByRole('button', { name: '历史后退' }));
  await screen.findByRole('link', { name: '阅读全文 d' });
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  repliesArea = await screen.findByRole('region', { name: '回复区 c-44' });
  expect(within(repliesArea).getAllByRole('listitem')).toHaveLength(3);
  await user.click(within(repliesArea).getByRole('button', { name: '展开回复' }));
  expect(within(repliesArea).getAllByRole('listitem')).toHaveLength(23);
});

it('同一动态两次访问的排序、评论范围及回复展开互不覆盖，成功详情不重复读取', async () => {
  const user = userEvent.setup();
  show(createControlledReader(baseReader(), { detail: { d: [{}, {}, { result: { status: 'error' } }] } }));
  const first = await open(user);
  await within(first).findByText('讨论 44');
  await user.click(within(first).getByRole('button', { name: '加载更多评论' }));
  const replyArea = await screen.findByRole('region', { name: '回复区 c-44' });
  await user.click(within(replyArea).getByRole('button', { name: '展开回复' }));
  await within(replyArea).findByText('答复 12');
  await user.click(screen.getByRole('button', { name: '新列表访问' }));
  const second = await open(user);
  await user.click(within(second).getByRole('button', { name: '最新' }));
  await within(second).findByText('讨论 0');
  await user.click(screen.getByRole('button', { name: '历史后退' }));
  await screen.findByRole('link', { name: '阅读全文 d' });
  await user.click(screen.getByRole('button', { name: '历史后退' }));
  const restored = await screen.findByRole('region', { name: '评论区' });
  expect(within(restored).getByRole('button', { name: '最热' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(restored).getByRole('list', { name: '一级评论' }).children).toHaveLength(40);
  expect(within(screen.getByRole('region', { name: '回复区 c-44' })).getByText('答复 12')).toBeVisible();
  await user.click(within(restored).getByRole('button', { name: '加载更多评论' }));
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  await screen.findByRole('link', { name: '阅读全文 d' });
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  const restoredSecond = await screen.findByRole('region', { name: '评论区' });
  expect(within(restoredSecond).getByRole('button', { name: '最新' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(restoredSecond).getByRole('list', { name: '一级评论' }).children).toHaveLength(20);
  expect(screen.queryByRole('region', { name: '回复区 c-44' })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each(['comments', 'replies'] as const)('加载中离开恢复%s原批次，保留成功内容且取消不显示为错误', async (areaName) => {
  const user = userEvent.setup();
  const commentPending = deferred<CommentBatch>();
  const replyPending = deferred<ReplyBatch>();
  const plan = areaName === 'comments'
    ? { comments: { d: { hot: [{}, { result: commentPending.promise, ignoreAbort: true }] } } }
    : { replies: { d: { 'c-44': [{}, { result: replyPending.promise, ignoreAbort: true }] } } };
  show(createControlledReader(baseReader(), plan));
  const area = await open(user);
  await within(area).findByText('讨论 44');
  if (areaName === 'comments') await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
  else {
    const repliesArea = await screen.findByRole('region', { name: '回复区 c-44' });
    await within(repliesArea).findByText('答复 0');
    await user.click(within(repliesArea).getByRole('button', { name: '展开回复' }));
  }
  await user.click(screen.getByRole('button', { name: '返回列表' }));
  await screen.findByRole('link', { name: '阅读全文 d' });
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  if (areaName === 'comments') {
    const restored = await screen.findByRole('region', { name: '评论区' });
    await within(restored).findByText('讨论 5');
    expect(within(restored).getByRole('list', { name: '一级评论' }).children).toHaveLength(40);
    await user.click(within(restored).getByRole('button', { name: '加载更多评论' }));
    expect(within(restored).getByRole('list', { name: '一级评论' }).children).toHaveLength(45);
  } else {
    const restored = await screen.findByRole('region', { name: '回复区 c-44' });
    await within(restored).findByText('答复 12');
    expect(within(restored).getAllByRole('listitem')).toHaveLength(13);
    await user.click(within(restored).getByRole('button', { name: '加载更多回复' }));
    expect(within(restored).getAllByRole('listitem')).toHaveLength(23);
  }
  await act(async () => (areaName === 'comments' ? commentPending : replyPending).reject(new Error('late cancelled request')));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('读取已取消，可重新读取。')).not.toBeInTheDocument();
});

it.each([
  ['comments', 'initial', 'success'], ['comments', 'initial', 'error'], ['comments', 'initial', 'rejection'],
  ['comments', 'append', 'success'], ['comments', 'append', 'error'], ['comments', 'append', 'rejection'],
  ['replies', 'initial', 'success'], ['replies', 'initial', 'error'], ['replies', 'initial', 'rejection'],
  ['replies', 'append', 'success'], ['replies', 'append', 'error'], ['replies', 'append', 'rejection'],
] as const)('历史返回%s %s仍在读取时，旧%s及完成不污染当前状态', async (areaName, phase, outcome) => {
  const user = userEvent.setup();
  const oldComments = deferred<CommentBatch>();
  const newComments = deferred<CommentBatch>();
  const oldReplies = deferred<ReplyBatch>();
  const newReplies = deferred<ReplyBatch>();
  const prefix = phase === 'append' ? [{}] : [];
  const reader = createControlledReader(baseReader(), areaName === 'comments'
    ? { comments: { d: { hot: [...prefix, { result: oldComments.promise, ignoreAbort: true }, { result: newComments.promise }] } } }
    : { replies: { d: { 'c-44': [...prefix, { result: oldReplies.promise, ignoreAbort: true }, { result: newReplies.promise }] } } });
  show(reader);
  let area = await open(user);
  if (areaName === 'replies') area = await screen.findByRole('region', { name: '回复区 c-44' });
  if (phase === 'append') {
    await within(area).findByText(areaName === 'comments' ? '讨论 44' : '答复 0');
    await user.click(within(area).getByRole('button', { name: areaName === 'comments' ? '加载更多评论' : '展开回复' }));
  }
  await within(area).findByText(`${areaName === 'comments' ? '最热评论' : '回复'}${phase === 'append' ? '追加' : ''}加载中…`);
  await user.click(screen.getByRole('button', { name: '返回列表' }));
  await screen.findByRole('link', { name: '阅读全文 d' });
  await user.click(screen.getByRole('button', { name: '历史前进' }));
  area = await screen.findByRole('region', { name: areaName === 'comments' ? '评论区' : '回复区 c-44' });
  await act(async () => {
    if (outcome === 'rejection') (areaName === 'comments' ? oldComments : oldReplies).reject(new Error('late failure'));
    else if (areaName === 'comments') oldComments.resolve(outcome === 'error' ? { status: 'error' }
      : { status: 'success', data: { items: [{ ...comments[0]!, id: 'stale', text: '过期内容' }], nextCursor: null } });
    else oldReplies.resolve(outcome === 'error' ? { status: 'error' }
      : { status: 'success', data: { items: [{ ...replies[0]!, id: 'stale', text: '过期内容' }], nextCursor: null } });
  });
  expect(within(area).getByText(`${areaName === 'comments' ? '最热评论' : '回复'}${phase === 'append' ? '追加' : ''}加载中…`)).toBeVisible();
  expect(screen.queryByText('过期内容')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => {
    if (areaName === 'comments') newComments.resolve({ status: 'success', data: {
      items: [{ ...comments[0]!, id: 'resumed', text: '恢复后内容' }], nextCursor: null,
    } });
    else newReplies.resolve({ status: 'success', data: {
      items: [{ ...replies[0]!, id: 'resumed', text: '恢复后内容' }], nextCursor: null,
    } });
  });
  expect(within(area).getByText('恢复后内容')).toBeVisible();
});

it('评论和回复读取中往返预览沿用底层访问，不取消请求、不重置分页或展开', async () => {
  const user = userEvent.setup();
  const commentPending = deferred<CommentBatch>();
  const replyPending = deferred<ReplyBatch>();
  const reader = createControlledReader(createMockReader({ creator, dynamics: [{ ...dynamic, images: [{
    id: 'image', thumbnailUrl: '/thumb.png', previewUrl: '/full.png', width: 600, height: 400,
  }] }], comments: { d: comments }, replies: { d: { 'c-44': replies } } }), {
    comments: { d: { hot: [{}, { result: commentPending.promise }] } },
    replies: { d: { 'c-44': [{}, { result: replyPending.promise }] } },
  });
  show(reader);
  const area = await open(user);
  await within(area).findByText('讨论 44');
  const replyArea = await screen.findByRole('region', { name: '回复区 c-44' });
  await within(replyArea).findByText('答复 0');
  await user.click(within(replyArea).getByRole('button', { name: '展开回复' }));
  await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
  await user.click(screen.getByRole('button', { name: '预览图片 1' }));
  await screen.findByRole('dialog');
  await act(async () => {
    commentPending.resolve({ status: 'success', data: { items: [{ ...comments[0]!, text: '预览期间有效评论' }], nextCursor: 'next' } });
    replyPending.resolve({ status: 'success', data: { items: replies.slice(3, 13), nextCursor: 'next' } });
  });
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(within(area).getByText('预览期间有效评论')).toBeVisible();
  expect(within(replyArea).getAllByRole('listitem')).toHaveLength(13);
  expect(within(replyArea).getByRole('button', { name: '加载更多回复' })).toBeEnabled();
  expect(within(area).getByRole('button', { name: '加载更多评论' })).toBeEnabled();
});
