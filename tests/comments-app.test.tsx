import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router';
import { expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import { createControlledReader } from '../src/dev/controlledReader';
import type { Comment, CommentBatch, DynamicReader, ReadResult } from '../src/data/contracts';

const creator = { id: 'up', nickname: '纸飞机', avatarUrl: null };
const dynamic = { id: 'd', author: creator, publishedAt: null, text: '上方动态保持完整', commentCount: 100 };
const comment: Comment = { id: 'c', author: creator, publishedAt: '2026-02-03T23:04:05-05:00', text: '第一行\n🙂 @朋友 <script>window.pwned=true</script>', likeCount: 0, replyCount: 0 };
it('评论和回复的 UP 标识按当前动态作者 ID，不按全局身份或同名判断', async () => {
  const author = { ...creator, id: 'actual-author' };
  show(createMockReader({ creator, dynamics: [{ ...dynamic, author }], comments: { d: [
    { ...comment, id: 'author-comment', author, text: '实际作者评论', replyCount: 2 },
    { ...comment, id: 'same-name', text: '同名不同 ID 评论' },
  ] }, replies: { d: { 'author-comment': [
    { id: 'author-reply', author, text: '实际作者回复', publishedAt: null, likeCount: 0, replyTo: null },
    { id: 'same-name-reply', author: creator, text: '同名不同 ID 回复', publishedAt: null, likeCount: 0, replyTo: null },
  ] } } }));
  const authorComment = (await screen.findByText('实际作者评论')).closest('li')!;
  const otherComment = screen.getByText('同名不同 ID 评论').closest('li')!;
  expect(within(authorComment).getByText('UP主')).toBeInTheDocument();
  expect(within(otherComment).queryByText('UP主')).not.toBeInTheDocument();
  const authorReply = (await screen.findByText('实际作者回复')).closest('li')!;
  const otherReply = screen.getByText('同名不同 ID 回复').closest('li')!;
  expect(within(authorReply).getByText('UP主')).toBeInTheDocument();
  expect(within(otherReply).queryByText('UP主')).not.toBeInTheDocument();
});

function deferred() {
  let resolve!: (value: ReadResult<CommentBatch>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ReadResult<CommentBatch>>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function show(reader: DynamicReader) {
  return render(<MemoryRouter initialEntries={['/dynamics/d']}><App reader={reader} /></MemoryRouter>);
}

it.each([
  ['other', 'success'], ['other', 'error'], ['other', 'rejection'],
  ['same', 'success'], ['same', 'error'], ['same', 'rejection'],
] as const)('离开后进入%s动态访问，旧%s不改写新访问也不提前结束当前加载', async (target, outcome) => {
  const user = userEvent.setup();
  const old = deferred();
  const current = deferred();
  const other = { ...dynamic, id: 'other', text: '另一动态正文' };
  const reader = createControlledReader(createMockReader({ creator, dynamics: [dynamic, other] }), { comments: {
    d: { hot: [{ result: old.promise, ignoreAbort: true }, ...(target === 'same' ? [{ result: current.promise }] : [])] },
    other: { hot: [{ result: current.promise }] },
  } });
  function ChangeVisit() {
    const navigate = useNavigate();
    return <button onClick={() => void navigate(`/dynamics/${target === 'same' ? 'd' : 'other'}`, { state: null })}>新详情访问</button>;
  }
  render(<MemoryRouter initialEntries={['/dynamics/d']}><ChangeVisit /><App reader={reader} /></MemoryRouter>);
  await screen.findByRole('region', { name: '评论区' });
  await user.click(screen.getByRole('button', { name: '新详情访问' }));
  const area = await screen.findByRole('region', { name: '评论区' });
  await act(async () => {
    if (outcome === 'rejection') old.reject(new Error('late failure'));
    else old.resolve(outcome === 'error' ? { status: 'error' } : { status: 'success', data: { items: [{ ...comment, text: '过期评论' }], nextCursor: null } });
  });
  expect(within(area).getByRole('status')).toHaveTextContent('最热评论加载中');
  expect(screen.queryByText('过期评论')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => current.resolve({ status: 'success', data: { items: [{ ...comment, text: '当前访问评论' }], nextCursor: null } }));
  expect(within(area).getByText('当前访问评论')).toBeVisible();
  expect(screen.getByText(target === 'same' ? '上方动态保持完整' : '另一动态正文')).toBeVisible();
});

it('无评论、当前取消可重读及追加取消可区分，批次边界重复ID不重复展示', async () => {
  const user = userEvent.setup();
  const base = createMockReader({ creator, dynamics: [dynamic] });
  const first = { items: [comment], nextCursor: 'batch-two' };
  show(createControlledReader(base, { comments: { d: { hot: [
    { result: { status: 'cancelled' } },
    { result: { status: 'success', data: first } },
    { result: { status: 'cancelled' } },
    { result: { status: 'success', data: { items: [comment, { ...comment, id: 'new', text: '新评论' }, { ...comment, id: 'new', text: '新评论' }], nextCursor: null } } },
  ] } } }));
  const area = await screen.findByRole('region', { name: '评论区' });
  await within(area).findByText('读取已取消，可重新读取。');
  expect(within(area).queryByRole('alert')).not.toBeInTheDocument();
  await user.click(within(area).getByRole('button', { name: '重新读取' }));
  await within(area).findByText(/第一行/);
  await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
  await within(area).findByText('读取已取消，可重新读取。');
  expect(within(area).getAllByRole('listitem')).toHaveLength(1);
  await user.click(within(area).getByRole('button', { name: '重新读取' }));
  await within(area).findByText('新评论');
  expect(within(area).getAllByRole('listitem')).toHaveLength(2);
  await user.click(within(area).getByRole('button', { name: '最新' }));
  expect(await within(area).findByText('暂无评论')).toBeVisible();
  expect(within(area).queryByRole('button', { name: '加载更多评论' })).not.toBeInTheDocument();
});

it.each([
  ['initial', 'success'], ['initial', 'error'], ['initial', 'rejection'],
  ['append', 'success'], ['append', 'error'], ['append', 'rejection'],
] as const)('快速切换中忽略取消的旧%s %s和完成回调不改写最后选择或提前结束新加载', async (phase, outcome) => {
  const user = userEvent.setup();
  const old = deferred();
  const current = deferred();
  const first = { items: [comment], nextCursor: 'next' };
  const base = createMockReader({ creator, dynamics: [dynamic] });
  const controlled = createControlledReader(base, { comments: { d: {
    hot: [
      ...(phase === 'append' ? [{ result: { status: 'success' as const, data: first } }] : []),
      { result: old.promise, ignoreAbort: true }, { result: current.promise },
    ],
  } } });
  const requests: Parameters<DynamicReader['readComments']>[0][] = [];
  show({ ...controlled, readComments(input) { requests.push(input); return controlled.readComments(input); } });
  const area = await screen.findByRole('region', { name: '评论区' });
  if (phase === 'append') {
    await within(area).findByText(/第一行/);
    const more = within(area).getByRole('button', { name: '加载更多评论' });
    fireEvent.click(more);
    fireEvent.click(more);
    expect(more).toBeDisabled();
    expect(requests).toHaveLength(2);
    expect(within(area).getByText('最热评论追加加载中…')).toBeVisible();
  }
  await user.click(within(area).getByRole('button', { name: '最新' }));
  await within(area).findByText('暂无评论');
  await user.click(within(area).getByRole('button', { name: '最热' }));
  expect(within(area).getByRole('status')).toHaveTextContent('最热评论加载中');
  const count = requests.length;
  await act(async () => {
    if (outcome === 'rejection') old.reject(new Error('late failure'));
    else old.resolve(outcome === 'error' ? { status: 'error' } : { status: 'success', data: { items: [{ ...comment, text: '过期评论' }], nextCursor: null } });
  });
  await user.click(within(area).getByRole('button', { name: '最热' }));
  expect(requests).toHaveLength(count);
  expect(within(area).getByRole('status')).toHaveTextContent('最热评论加载中');
  expect(within(area).queryByText('过期评论')).not.toBeInTheDocument();
  expect(within(area).queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => current.resolve({ status: 'success', data: first }));
  expect(within(area).getByText(/第一行/)).toBeVisible();
  expect(within(area).getByRole('button', { name: '加载更多评论' })).toBeEnabled();
  expect(screen.getByText('上方动态保持完整')).toBeVisible();
});

it.each(['success', 'error', 'rejection'] as const)('新排序先成功后，忽略取消的旧排序%s逆序到达不覆盖结果或下一批', async outcome => {
  const user = userEvent.setup();
  const old = deferred();
  const latest = deferred();
  const base = createMockReader({ creator, dynamics: [dynamic] });
  show(createControlledReader(base, { comments: { d: {
    hot: [{ result: old.promise, ignoreAbort: true }],
    latest: [{ result: latest.promise }, { result: { status: 'success', data: { items: [{ ...comment, id: 'next', text: '新排序第二批' }], nextCursor: null } } }],
  } } }));
  const area = await screen.findByRole('region', { name: '评论区' });
  await user.click(within(area).getByRole('button', { name: '最新' }));
  await act(async () => latest.resolve({ status: 'success', data: { items: [{ ...comment, text: '最终选择评论' }], nextCursor: 'latest-next' } }));
  expect(within(area).getByText('最终选择评论')).toBeVisible();
  await act(async () => {
    if (outcome === 'rejection') old.reject(new Error('late failure'));
    else old.resolve(outcome === 'error' ? { status: 'error' } : { status: 'success', data: { items: [{ ...comment, text: '过期排序评论' }], nextCursor: null } });
  });
  expect(within(area).getByRole('button', { name: '最新' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(area).getByText('最终选择评论')).toBeVisible();
  expect(within(area).queryByText('过期排序评论')).not.toBeInTheDocument();
  expect(within(area).queryByRole('alert')).not.toBeInTheDocument();
  await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
  expect(await within(area).findByText('新排序第二批')).toBeVisible();
  expect(within(area).getAllByRole('listitem')).toHaveLength(2);
  expect(within(area).getByText('评论已加载完毕')).toBeVisible();
  expect(screen.getByText('上方动态保持完整')).toBeVisible();
});

it('当前评论读取拒绝后保留动态并在目标排序局部重试', async () => {
  const user = userEvent.setup();
  const pending = deferred();
  const base = createMockReader({ creator, dynamics: [dynamic], comments: { d: [comment] } });
  show(createControlledReader(base, { comments: { d: { hot: [{ result: pending.promise }] } } }));
  const area = await screen.findByRole('region', { name: '评论区' });
  await act(async () => pending.reject(new Error('network failure')));
  expect(await within(area).findByRole('alert')).toHaveTextContent('最热评论读取失败');
  expect(screen.getByText('上方动态保持完整')).toBeVisible();
  await user.click(within(area).getByRole('button', { name: '重试' }));
  expect(await within(area).findByText(/第一行/)).toBeVisible();
  expect(within(area).queryByRole('alert')).not.toBeInTheDocument();
});

it('首次、目标排序及追加错误各自局部重试，追加保留内容并重读原批次', async () => {
  const user = userEvent.setup();
  const base = createMockReader({ creator, dynamics: [dynamic], comments: { d: Array.from({ length: 45 }, (_, i) => ({
    ...comment, id: String(i).padStart(2, '0'), text: `评论正文 ${i}`, likeCount: i,
  })) } });
  const controlled = createControlledReader(base, { comments: { d: {
    hot: [{ result: { status: 'error' } }, {}, { result: { status: 'error' } }],
    latest: [{ result: { status: 'error' } }],
  } } });
  const requests: Parameters<DynamicReader['readComments']>[0][] = [];
  show({ ...controlled, readComments(input) { requests.push(input); return controlled.readComments(input); } });
  const area = await screen.findByRole('region', { name: '评论区' });
  expect(await within(area).findByRole('alert')).toHaveTextContent('最热评论读取失败');
  await user.click(within(area).getByRole('button', { name: '重试' }));
  await within(area).findByText('评论正文 44');
  await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
  expect(await within(area).findByRole('alert')).toHaveTextContent('最热评论追加读取失败');
  expect(within(area).getAllByRole('listitem')).toHaveLength(20);
  const failedCursor = requests[requests.length - 1]?.cursor;
  await user.click(within(area).getByRole('button', { name: '重试' }));
  expect(within(area).getAllByRole('listitem')).toHaveLength(40);
  expect(requests[requests.length - 1]?.cursor).toBe(failedCursor);
  await user.click(within(area).getByRole('button', { name: '最新' }));
  expect(await within(area).findByRole('alert')).toHaveTextContent('最新评论读取失败');
  expect(within(area).queryByRole('listitem')).not.toBeInTheDocument();
  expect(screen.getByText('上方动态保持完整')).toBeVisible();
  await user.click(within(area).getByRole('button', { name: '重试' }));
  await within(area).findByText('评论正文 0');
  expect(within(area).getAllByRole('listitem')).toHaveLength(20);
  const retried = requests[requests.length - 1];
  expect(retried?.sort).toBe('latest');
  expect(retried?.cursor).toBeUndefined();
});

it('两种排序20、20、5连续读完，切换丢弃旧进度但保留上方动态节点', async () => {
  const user = userEvent.setup();
  show(createMockReader({ creator, dynamics: [dynamic], comments: { d: Array.from({ length: 45 }, (_, i) => ({
    ...comment, id: String(i).padStart(2, '0'), text: `评论正文 ${i}`, likeCount: i,
  })) } }));
  const area = await screen.findByRole('region', { name: '评论区' });
  const upper = screen.getByText('上方动态保持完整');
  for (const sort of ['最热', '最新']) {
    if (sort === '最新') await user.click(within(area).getByRole('button', { name: sort }));
    await within(area).findByText(sort === '最热' ? '评论正文 44' : '评论正文 0');
    expect(within(area).getAllByRole('listitem')).toHaveLength(20);
    await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
    expect(within(area).getAllByRole('listitem')).toHaveLength(40);
    await user.click(within(area).getByRole('button', { name: '加载更多评论' }));
    expect(within(area).getAllByRole('listitem')).toHaveLength(45);
    expect(within(area).getByText('评论已加载完毕')).toBeVisible();
    expect(within(area).queryByRole('button', { name: '加载更多评论' })).not.toBeInTheDocument();
    expect(screen.getByText('上方动态保持完整')).toBe(upper);
  }
  await user.click(within(area).getByRole('button', { name: '最热' }));
  await within(area).findByText('评论正文 44');
  expect(within(area).getAllByRole('listitem')).toHaveLength(20);
  expect(screen.getByText('评论 100')).toBeVisible();
});

it('详情默认最热，一级评论安全展示身份、北京时间及只读计数；UP主按ID而非同名识别', async () => {
  show(createMockReader({ creator, dynamics: [dynamic], comments: { d: [
    comment,
    { ...comment, id: 'other', author: { ...creator, id: 'other' }, text: '', publishedAt: null, likeCount: null },
    { ...comment, id: 'missing-name', author: { id: 'unknown', nickname: null, avatarUrl: null }, text: '缺失昵称评论' },
  ] } }));
  const area = await screen.findByRole('region', { name: '评论区' });
  await within(area).findByText(/第一行/);
  expect(within(area).getByRole('button', { name: '最热' })).toHaveAttribute('aria-pressed', 'true');
  const rows = within(area).getAllByRole('listitem');
  const authorRow = rows.find(row => within(row).queryByText(/第一行/))!;
  const emptyRow = rows.find(row => within(row).queryByText('暂无评论内容'))!;
  expect(within(authorRow).getByText('UP主')).toBeVisible();
  expect(within(emptyRow).queryByText('UP主')).not.toBeInTheDocument();
  expect(within(authorRow).getByText('2026-02-04 12:04:05')).toBeVisible();
  expect(within(authorRow).getByText('点赞 0')).toBeVisible();
  expect(within(emptyRow).getByText('点赞 —')).toBeVisible();
  expect(within(emptyRow).getByText('暂无评论内容')).toBeVisible();
  expect(within(emptyRow).getByText('时间未知')).toBeVisible();
  expect(within(authorRow).getByRole('img')).toHaveAttribute('src', '/default-avatar.svg');
  const missingName = rows.find(row => within(row).queryByText('缺失昵称评论'))!;
  expect(within(missingName).getByText('未知用户')).toBeVisible();
  expect(within(missingName).queryByText('UP主')).not.toBeInTheDocument();
  expect(area.querySelector('script')).toBeNull();
  expect(within(area).queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByText('评论 100')).toBeVisible();
  expect(within(area).getByText('评论已加载完毕')).toBeVisible();
});
