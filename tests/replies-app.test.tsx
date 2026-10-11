import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router';
import { expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import { createControlledReader } from '../src/dev/controlledReader';
import type { DynamicReader, ReadResult, ReplyBatch } from '../src/data/contracts';

const creator = { id: 'up', nickname: '纸飞机', avatarUrl: null };
const dynamic = { id: 'd', author: creator, publishedAt: null, text: '上方动态保持完整', commentCount: 26 };
const root = { id: 'root', author: creator, publishedAt: null, text: '主讨论', likeCount: 10, replyCount: 25 };
const reply = { id: 'r', author: creator, publishedAt: '2026-02-03T23:04:05-05:00', text: '第一行\n🙂 <script>window.pwned=true</script>', likeCount: 0, replyTo: creator };
const replies = Array.from({ length: 25 }, (_, i) => ({ ...reply, id: `r-${String(i).padStart(2, '0')}`, text: `回复正文 ${i}` }));
function baseReader() {
  return createMockReader({ creator, dynamics: [dynamic], comments: { d: [root] }, replies: { d: { root: replies } } });
}
function show(reader: DynamicReader) {
  return render(<MemoryRouter initialEntries={['/dynamics/d']}><App reader={reader} /></MemoryRouter>);
}
function deferred() {
  let resolve!: (value: ReadResult<ReplyBatch>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ReadResult<ReplyBatch>>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

it('首次和追加失败原区原批重试、重复点击不重读，其他根评论请求不受重试影响', async () => {
  const user = userEvent.setup();
  const otherPending = deferred();
  const appendPending = deferred();
  const base = createMockReader({ creator, dynamics: [dynamic], comments: { d: [root, { ...root, id: 'other', text: '其他讨论' }] },
    replies: { d: { root: replies, other: replies } } });
  const controlled = createControlledReader(base, { replies: { d: {
    root: [{ result: { status: 'error' } }, {}, { result: { status: 'error' } }, { result: appendPending.promise }],
    other: [{ result: otherPending.promise }],
  } } });
  const requests: Parameters<DynamicReader['readReplies']>[0][] = [];
  show({ ...controlled, readReplies(input) { requests.push(input); return controlled.readReplies(input); } });
  const area = await screen.findByRole('region', { name: '回复区 root' });
  const otherArea = screen.getByRole('region', { name: '回复区 other' });
  expect(await within(area).findByRole('alert')).toHaveTextContent('回复读取失败');
  expect(within(otherArea).getByRole('status')).toHaveTextContent('回复加载中');
  within(area).getByRole('button', { name: '重试' }).focus();
  await user.keyboard('{Enter}');
  await within(area).findByText('回复正文 0');
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(await within(area).findByRole('alert')).toHaveTextContent('回复追加读取失败');
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  const failedCursor = requests.filter(input => input.rootId === 'root').at(-1)?.cursor;
  const retry = within(area).getByRole('button', { name: '重试' });
  fireEvent.click(retry);
  fireEvent.click(retry);
  const rootRequests = requests.filter(input => input.rootId === 'root');
  expect(rootRequests).toHaveLength(4);
  expect(rootRequests.at(-1)?.cursor).toBe(failedCursor);
  expect(within(area).getByRole('button', { name: '加载更多回复' })).toBeDisabled();
  expect(requests.find(input => input.rootId === 'other')?.signal.aborted).toBe(false);
  await act(async () => otherPending.resolve({ status: 'success', data: { items: [{ ...reply, text: '其他回复保持有效' }], nextCursor: null } }));
  expect(within(otherArea).getByText('其他回复保持有效')).toBeVisible();
  expect(within(area).getByRole('status')).toHaveTextContent('回复追加加载中');
  await act(async () => appendPending.resolve({ status: 'success', data: { items: replies.slice(3, 13), nextCursor: 'next' } }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(13);
  expect(screen.getByText('上方动态保持完整')).toBeVisible();
  expect(screen.getByText('其他讨论')).toBeVisible();
});

it.each([
  ['initial', 'success'], ['initial', 'error'], ['initial', 'rejection'],
  ['append', 'success'], ['append', 'error'], ['append', 'rejection'],
] as const)('切换排序使旧回复%s %s及完成失效，切回首批且顺序仍正序', async (phase, outcome) => {
  const user = userEvent.setup();
  const old = deferred();
  const current = deferred();
  const controlled = createControlledReader(baseReader(), { replies: { d: { root: [
    ...(phase === 'append' ? [{}] : []), { result: old.promise, ignoreAbort: true }, {}, { result: current.promise },
  ] } } });
  show(controlled);
  let area = await screen.findByRole('region', { name: '回复区 root' });
  if (phase === 'append') {
    await within(area).findByText('回复正文 0');
    await user.click(within(area).getByRole('button', { name: '展开回复' }));
  }
  await user.click(screen.getByRole('button', { name: '最新' }));
  area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText('回复正文 0');
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  expect(within(area).getByRole('button', { name: '展开回复' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '最热' }));
  area = await screen.findByRole('region', { name: '回复区 root' });
  await act(async () => {
    if (outcome === 'rejection') old.reject(new Error('late failure'));
    else old.resolve(outcome === 'error' ? { status: 'error' } : { status: 'success', data: { items: [{ ...reply, text: '过期回复' }], nextCursor: null } });
  });
  expect(within(area).getByRole('status')).toHaveTextContent('回复加载中');
  expect(screen.queryByText('过期回复')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => current.resolve({ status: 'success', data: { items: replies.slice(0, 3), nextCursor: 'next' } }));
  expect(within(area).getAllByRole('listitem').map(row => within(row).getByText(/^回复正文/).textContent)).toEqual(['回复正文 0', '回复正文 1', '回复正文 2']);
  expect(within(area).queryByRole('button', { name: '收起回复' })).not.toBeInTheDocument();
});

it.each(['success', 'error', 'rejection'] as const)('同动态新访问隔离旧回复%s，不影响当前加载完成', async outcome => {
  const user = userEvent.setup();
  const old = deferred();
  const current = deferred();
  const reader = createControlledReader(baseReader(), { replies: { d: { root: [
    { result: old.promise, ignoreAbort: true }, { result: current.promise },
  ] } } });
  function ChangeVisit() {
    const navigate = useNavigate();
    return <button onClick={() => void navigate('/dynamics/d', { state: null })}>新详情访问</button>;
  }
  render(<MemoryRouter initialEntries={['/dynamics/d']}><ChangeVisit /><App reader={reader} /></MemoryRouter>);
  await screen.findByRole('region', { name: '回复区 root' });
  await user.click(screen.getByRole('button', { name: '新详情访问' }));
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await act(async () => {
    if (outcome === 'rejection') old.reject(new Error('late failure'));
    else old.resolve(outcome === 'error' ? { status: 'error' } : { status: 'success', data: { items: [{ ...reply, text: '旧访问回复' }], nextCursor: null } });
  });
  expect(within(area).getByRole('status')).toHaveTextContent('回复加载中');
  expect(screen.queryByText('旧访问回复')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => current.resolve({ status: 'success', data: { items: [{ ...reply, text: '新访问回复' }], nextCursor: null } }));
  expect(within(area).getByText('新访问回复')).toBeVisible();
});

it('回复取消可重新读取不是错误，批次重复ID不重复展示', async () => {
  const user = userEvent.setup();
  show(createControlledReader(baseReader(), { replies: { d: { root: [
    { result: { status: 'cancelled' } }, {}, { result: { status: 'cancelled' } },
    { result: { status: 'success', data: { items: [replies[0]!, replies[3]!, replies[3]!], nextCursor: null } } },
  ] } } }));
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText('读取已取消，可重新读取。');
  expect(within(area).queryByRole('alert')).not.toBeInTheDocument();
  await user.click(within(area).getByRole('button', { name: '重新读取' }));
  await within(area).findByText('回复正文 0');
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await within(area).findByText('读取已取消，可重新读取。');
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  await user.click(within(area).getByRole('button', { name: '重新读取' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(4);
  expect(within(area).getByText('回复已加载完毕')).toBeVisible();
});

it('追加中收起只改变可见范围，迟到的有效结果保留缓存，再展开不重复请求', async () => {
  const user = userEvent.setup();
  const pending = deferred();
  const controlled = createControlledReader(baseReader(), { replies: { d: { root: [{}, { result: pending.promise }] } } });
  const requests: Parameters<DynamicReader['readReplies']>[0][] = [];
  show({ ...controlled, readReplies(input) { requests.push(input); return controlled.readReplies(input); } });
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText('回复正文 0');
  const expand = within(area).getByRole('button', { name: '展开回复' });
  fireEvent.click(expand);
  fireEvent.click(expand);
  expect(requests).toHaveLength(2);
  await user.click(within(area).getByRole('button', { name: '收起回复' }));
  expect(within(area).getByRole('button', { name: '展开回复' })).toBeDisabled();
  await act(async () => pending.resolve({ status: 'success', data: { items: replies.slice(3, 13), nextCursor: 'next' } }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(13);
  expect(requests).toHaveLength(2);
});

it('25条回复3/13/23/25、收起恢复缓存不重读，结束无下一批且完整计数保持不变', async () => {
  const user = userEvent.setup();
  const base = baseReader();
  const requests: Parameters<DynamicReader['readReplies']>[0][] = [];
  show({ ...base, readReplies(input) { requests.push(input); return base.readReplies(input); } });
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText('回复正文 0');
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  expect(screen.getByText('回复 25', { exact: true })).toBeVisible();
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(13);
  const nextCursor = requests[requests.length - 1]?.cursor;
  await user.click(within(area).getByRole('button', { name: '收起回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(3);
  const count = requests.length;
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(13);
  expect(requests).toHaveLength(count);
  await user.click(within(area).getByRole('button', { name: '加载更多回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(23);
  expect(requests[requests.length - 1]?.cursor).not.toBe(nextCursor);
  await user.click(within(area).getByRole('button', { name: '加载更多回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(25);
  expect(within(area).getAllByRole('listitem').map(row => within(row).getByText(/^回复正文/).textContent)).toEqual([
    '回复正文 0', '回复正文 1', '回复正文 2', '回复正文 3', '回复正文 4', '回复正文 5',
    '回复正文 6', '回复正文 7', '回复正文 8', '回复正文 9', '回复正文 10', '回复正文 11',
    '回复正文 12', '回复正文 13', '回复正文 14', '回复正文 15', '回复正文 16', '回复正文 17',
    '回复正文 18', '回复正文 19', '回复正文 20', '回复正文 21', '回复正文 22', '回复正文 23', '回复正文 24',
  ]);
  expect(within(area).getByText('回复已加载完毕')).toBeVisible();
  expect(within(area).queryByRole('button', { name: '加载更多回复' })).not.toBeInTheDocument();
  await user.click(within(area).getByRole('button', { name: '收起回复' }));
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(25);
  expect(requests).toHaveLength(4);
  expect(requests.map(input => input.limit)).toEqual([3, 10, 10, 10]);
  expect(screen.getByText('回复 25', { exact: true })).toBeVisible();
  expect(screen.getByText('评论 26', { exact: true })).toBeVisible();
});

it('一级评论显示来源完整回复数，回复平铺并安全显示目标、身份、北京时间及缺失兜底', async () => {
  show(createMockReader({ creator, dynamics: [dynamic], comments: { d: [
    { ...root, replyCount: 3 }, { ...root, id: 'zero', text: '无回复评论', likeCount: 0, replyCount: 0 },
    { ...root, id: 'unknown', text: '未知回复数', likeCount: null, replyCount: null },
  ] }, replies: { d: { root: [reply,
    { ...reply, id: 'same-name', author: { ...creator, id: 'other' }, text: '同名非UP', replyTo: { id: 'unknown', nickname: null, avatarUrl: null } },
    { ...reply, id: 'missing', author: { id: 'missing', nickname: null, avatarUrl: null }, publishedAt: null, text: '', likeCount: null, replyTo: null },
  ] } } }));
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText(/第一行/);
  expect(screen.getByText('回复 3', { exact: true })).toBeVisible();
  expect(screen.getByText('回复 0', { exact: true })).toBeVisible();
  expect(screen.getByText('回复 —', { exact: true })).toBeVisible();
  expect(await within(screen.getByRole('region', { name: '回复区 unknown' })).findByText('暂无回复')).toBeVisible();
  const rows = within(area).getAllByRole('listitem');
  expect(rows).toHaveLength(3);
  const authorReply = rows.find(row => within(row).queryByText(/第一行/))!;
  expect(within(authorReply).getByText('UP主')).toBeVisible();
  expect(within(authorReply).getByText('回复 @纸飞机')).toBeVisible();
  expect(within(authorReply).getByText('2026-02-04 12:04:05')).toBeVisible();
  expect(within(authorReply).getByText('点赞 0')).toBeVisible();
  const missing = rows.find(row => within(row).queryByText('暂无评论内容'))!;
  expect(within(missing).getByText('未知用户')).toBeVisible();
  expect(within(missing).getByText('时间未知')).toBeVisible();
  expect(within(missing).getByText('点赞 —')).toBeVisible();
  expect(within(missing).getByRole('img')).toHaveAttribute('src', '/default-avatar.svg');
  expect(within(missing).queryByText(/回复 @/)).not.toBeInTheDocument();
  expect(within(area).queryByText('回复 @未知用户')).not.toBeInTheDocument();
  expect(within(rows.find(row => within(row).queryByText('同名非UP'))!).queryByText('UP主')).not.toBeInTheDocument();
  expect(area.querySelector('script')).toBeNull();
  expect(within(area).queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /展开回复|加载更多回复/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '回复区 zero' })).not.toBeInTheDocument();
});
