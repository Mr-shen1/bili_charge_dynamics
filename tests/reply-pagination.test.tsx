import { act, fireEvent, getNodeText, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import type { DynamicReader, ReadResult, ReplyBatch } from '../src/data/contracts';
import { createMockReader } from '../src/data/mockReader';
import { replyPageEntries } from '../src/dynamics/ReplyPager';

const author = { id: 'up', nickname: '分页作者', avatarUrl: null };
const dynamic = { id: 'd', author, publishedAt: null, text: '分页动态', commentCount: 1 };
const root = { id: 'root', author, publishedAt: null, text: '分页主评论', likeCount: 0, replyCount: 90 };

function fixture(localCount = 90, sourceCount = localCount) {
  const replies = Array.from({ length: localCount }, (_, index) => ({
    id: `reply-${String(index).padStart(3, '0')}`, author, publishedAt: null,
    text: `分页回复 ${index}`, likeCount: 0, replyTo: null,
  }));
  const base = createMockReader({ creator: author, dynamics: [dynamic],
    comments: { d: [{ ...root, replyCount: sourceCount }] }, replies: { d: { root: replies } } });
  const readReplies = vi.fn<DynamicReader['readReplies']>(async input => {
    const result = await base.readReplies(input);
    return result.status === 'success' ? { status: 'success', data: {
      ...result.data, root, sourceReplyCount: sourceCount, localReplyCount: localCount,
      repliesLastAttempt: 'success',
    } } : result;
  });
  return { reader: { ...base, readReplies }, readReplies, replies };
}

function show(reader: DynamicReader, path = '/dynamics/d') {
  render(<MemoryRouter initialEntries={[path]}><App reader={reader} /></MemoryRouter>);
}

async function expand(user: ReturnType<typeof userEvent.setup>) {
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText('分页回复 0');
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await waitFor(() => expect(within(area).getAllByRole('listitem')).toHaveLength(10));
  return area;
}

function rows(area: HTMLElement) {
  return within(area).getAllByRole('listitem').map(row => getNodeText(within(row).getByText(/^分页回复 /)).trim());
}

it('参考图9页窗口整页直达末页，点同页、返回旧页及再次展开均读取当前数据', async () => {
  const user = userEvent.setup();
  const { reader, readReplies, replies } = fixture();
  show(reader);
  const area = await expand(user);
  const pager = within(area).getByRole('navigation', { name: '回复分页' });
  expect(pager).toHaveTextContent('共9页');
  expect(within(pager).getAllByRole('button').map(button => button.textContent)).toEqual(['1', '2', '3', '4', '5', '9', '下一页', '收起']);
  replies[0]!.text = '分页回复 0（同页更新）';
  await user.click(within(pager).getByRole('button', { name: '1' }));
  await within(area).findByText('分页回复 0（同页更新）');
  expect(readReplies).toHaveBeenCalledTimes(3);
  await user.click(within(pager).getByRole('button', { name: '9' }));
  await within(area).findByText('分页回复 89');
  expect(rows(area)).toEqual(Array.from({ length: 10 }, (_, index) => `分页回复 ${80 + index}`));
  expect(within(pager).getByRole('button', { name: '下一页' })).toBeDisabled();
  replies[0]!.text = '分页回复 0（返回重读）';
  await user.click(within(pager).getByRole('button', { name: '1' }));
  await within(area).findByText('分页回复 0（返回重读）');
  expect(rows(area)).toEqual(['分页回复 0（返回重读）', ...Array.from({ length: 9 }, (_, index) => `分页回复 ${index + 1}`)]);
  await user.click(within(pager).getByRole('button', { name: '收起' }));
  expect(rows(area)).toEqual(['分页回复 0', '分页回复 1', '分页回复 2']);
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  expect(rows(area)).toHaveLength(10);
  await waitFor(() => expect(within(area).getByRole('button', { name: '下一页' })).toBeEnabled());
  expect(within(area).getByText('分页回复 0（返回重读）')).toBeVisible();
  expect(readReplies.mock.calls.map(([input]) => input.page)).toEqual([undefined, 1, 1, 9, 1, 1]);
  expect(readReplies.mock.calls.map(([input]) => input.limit)).toEqual([3, 10, 10, 10, 10, 10]);
  expect(readReplies.mock.calls.every(([input]) => input.cursor == null)).toBe(true);
});

it('切换第5页显示前后各两页，上一页和下一页均读取目标整页', async () => {
  const user = userEvent.setup();
  const { reader, readReplies } = fixture();
  show(reader);
  const area = await expand(user);
  await user.click(within(area).getByRole('button', { name: '5' }));
  await within(area).findByText('分页回复 49');
  const pager = within(area).getByRole('navigation', { name: '回复分页' });
  expect(pager).toHaveTextContent('共9页上一页1…34567…9下一页收起');
  expect(rows(area)).toEqual(Array.from({ length: 10 }, (_, index) => `分页回复 ${40 + index}`));
  await user.click(within(pager).getByRole('button', { name: '上一页' }));
  expect(within(pager).getByRole('button', { name: '4' })).toHaveAttribute('aria-current', 'page');
  expect(rows(area)).toEqual(Array.from({ length: 10 }, (_, index) => `分页回复 ${30 + index}`));
  await user.click(within(pager).getByRole('button', { name: '下一页' }));
  await within(area).findByText('分页回复 49');
  expect(readReplies.mock.calls.map(([input]) => input.page)).toEqual([undefined, 1, 5, 4, 5]);
});

it('来源90条但本地仅25条时只提供3个可读页面，不生成空白页', async () => {
  const user = userEvent.setup();
  const { reader } = fixture(25, 90);
  show(reader);
  const area = await expand(user);
  expect(within(area).getByRole('navigation', { name: '回复分页' })).toHaveTextContent('共3页');
  expect(within(area).queryByRole('button', { name: '9' })).not.toBeInTheDocument();
  await user.click(within(area).getByRole('button', { name: '3' }));
  await within(area).findByText('分页回复 24');
  expect(rows(area)).toEqual(Array.from({ length: 5 }, (_, index) => `分页回复 ${20 + index}`));
  expect(within(area).getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(within(area).getByText('已归档 25/90，上游另有 65 条回复未返回。')).toBeVisible();
});

it('读取中禁用翻页但允许收起，重复点击不发起额外请求', async () => {
  const user = userEvent.setup();
  const { reader, readReplies } = fixture();
  const original = reader.readReplies;
  let resolve!: (result: ReadResult<ReplyBatch>) => void;
  const pending = new Promise<ReadResult<ReplyBatch>>(done => { resolve = done; });
  const requests = vi.fn<DynamicReader['readReplies']>(input => input.page !== undefined ? pending : original(input));
  show({ ...reader, readReplies: requests });
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText('分页回复 0');
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  const pager = within(area).getByRole('navigation', { name: '回复分页' });
  for (const button of within(pager).getAllByRole('button').filter(button => button.textContent !== '收起')) {
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(within(pager).getByRole('button', { name: '收起' })).toBeEnabled();
  expect(requests).toHaveBeenCalledTimes(2);
  expect(requests.mock.calls[1]?.[0]).toMatchObject({ page: 1, limit: 10 });
  await user.click(within(pager).getByRole('button', { name: '收起' }));
  expect(requests.mock.calls[1]?.[0].signal.aborted).toBe(true);
  await act(async () => resolve({ status: 'success', data: { items: [], nextCursor: null, root, count: 90 } }));
  expect(rows(area)).toHaveLength(3);
  expect(readReplies).toHaveBeenCalledTimes(1);
  expect(requests).toHaveBeenCalledTimes(2);
  expect(within(area).getByRole('button', { name: '展开回复' })).toBeEnabled();
});

it('直跳第9页失败保留旧page1，重试仅重读目标page9而非游标补齐', async () => {
  const user = userEvent.setup();
  const { reader } = fixture();
  const requests: Parameters<DynamicReader['readReplies']>[0][] = [];
  show({ ...reader, async readReplies(input) {
    requests.push(input);
    if (requests.length === 3) return { status: 'error' };
    return reader.readReplies(input);
  } });
  const area = await expand(user);
  await user.click(within(area).getByRole('button', { name: '9' }));
  await within(area).findByRole('alert');
  expect(requests.map(input => input.page)).toEqual([undefined, 1, 9]);
  expect(rows(area)).toEqual(Array.from({ length: 10 }, (_, index) => `分页回复 ${index}`));
  expect(within(area).getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
  await user.click(within(area).getByRole('button', { name: '重试' }));
  await within(area).findByText('分页回复 89');
  expect(rows(area)).toHaveLength(10);
  expect(within(area).getByRole('button', { name: '9' })).toHaveAttribute('aria-current', 'page');
  expect(requests.map(input => input.page)).toEqual([undefined, 1, 9, 9]);
  expect(requests.every(input => input.cursor == null)).toBe(true);
});

it('手机楼中楼详情首次单次请求page1十条并显示根评论', async () => {
  const { reader, readReplies } = fixture();
  show(reader, '/dynamics/d/comments/root');
  const list = await screen.findByRole('list', { name: '相关回复' });
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(10));
  expect(within(list).getByText('分页回复 9')).toBeVisible();
  expect(within(screen.getByRole('article', { name: '被回复的评论' })).getByText('分页主评论')).toBeVisible();
  expect(readReplies).toHaveBeenCalledTimes(1);
  expect(readReplies.mock.calls[0]?.[0]).toMatchObject({ page: 1, limit: 10 });
  expect(readReplies.mock.calls[0]?.[0].cursor).toBeUndefined();
});

it('localReplyCount缺失仍使用当前count；缩页后跳转失效高页码重新读取最新末页', async () => {
  const user = userEvent.setup();
  const { reader, replies } = fixture();
  const requests: Parameters<DynamicReader['readReplies']>[0][] = [];
  show({ ...reader, async readReplies(input) {
    requests.push(input);
    const result = await reader.readReplies(input);
    if (result.status !== 'success') return result;
    const { localReplyCount: _local, ...data } = result.data;
    return { status: 'success', data: { ...data, ...(input.page !== undefined ? { count: replies.length } : {}) } };
  } });
  const area = await expand(user);
  expect(within(area).getByRole('navigation', { name: '回复分页' })).toHaveTextContent('共9页');
  replies.splice(25);
  await user.click(within(area).getByRole('button', { name: '9' }));
  await within(area).findByText('分页回复 24');
  expect(within(area).getByRole('navigation', { name: '回复分页' })).toHaveTextContent('共3页');
  expect(within(area).getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page');
  expect(rows(area)).toHaveLength(5);
  expect(within(area).getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(requests.map(input => input.page)).toEqual([undefined, 1, 9, 3]);
});

it('手机详情兼容读取标记失效响应后显式重启，单次page1恢复完整第一页', async () => {
  const user = userEvent.setup();
  const { reader } = fixture();
  let calls = 0;
  show({ ...reader, async readReplies(input) {
    calls += 1;
    if (calls === 2) return { status: 'error', reason: 'invalid-cursor' };
    return reader.readReplies(input);
  } }, '/dynamics/d/comments/root');
  const list = await screen.findByRole('list', { name: '相关回复' });
  await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(10));
  await user.click(screen.getByRole('button', { name: '9' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '重新开始读取' }));
  const restarted = await screen.findByRole('list', { name: '相关回复' });
  await within(restarted).findByText('分页回复 9');
  expect(within(restarted).getAllByRole('listitem')).toHaveLength(10);
  expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
  expect(calls).toBe(3);
});

it.each([8, 9])('窄屏第%i页不会重复末页或在末尾留下省略号', page => {
  const entries = replyPageEntries(page, 9, true);
  const numbers = entries.filter(entry => typeof entry === 'number');
  expect(new Set(numbers).size).toBe(numbers.length);
  expect(entries).toEqual([1, '…', 7, 8, 9]);
});
