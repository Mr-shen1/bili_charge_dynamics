import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import type { DynamicReader, Reply } from '../src/data/contracts';
import { createMockReader } from '../src/data/mockReader';

const creator = { id: 'up', nickname: '楼主', avatarUrl: null };
const root = { id: 'root', author: creator, publishedAt: null, text: '当前根评论', likeCount: 0, replyCount: 21 };
function reply(index: number): Reply {
  return { id: `reply-${String(index).padStart(3, '0')}`, author: creator, parentId: null,
    publishedAt: null, text: `回复正文 ${index}`, likeCount: 0, replyTo: null };
}
function fixture() {
  const replies = Array.from({ length: 21 }, (_, index) => reply(index));
  const base = createMockReader({ creator,
    dynamics: [{ id: 'd', author: creator, publishedAt: null, text: '动态正文', commentCount: 1 }],
    comments: { d: [root] }, replies: { d: { root: replies } },
  });
  const requests: Parameters<DynamicReader['readReplies']>[0][] = [];
  const reader: DynamicReader = { ...base, readReplies(input) {
    requests.push(input);
    return base.readReplies(input);
  } };
  return { replies, reader, requests };
}
function show(reader: DynamicReader, path = '/dynamics/d') {
  render(<MemoryRouter initialEntries={[path]}><App reader={reader} /></MemoryRouter>);
}
afterEach(() => vi.unstubAllGlobals());

it('桌面停在倒数第二页后新增回复，下一页及重复点击页码都查询最新数据', async () => {
  const user = userEvent.setup();
  const { reader, replies, requests } = fixture();
  show(reader);
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText(/回复正文 0/);
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await within(area).findByText(/回复正文 9/);
  await user.click(within(area).getByRole('button', { name: '2' }));
  await within(area).findByText(/回复正文 19/);
  replies.push(reply(21));
  await user.click(within(area).getByRole('button', { name: '下一页' }));
  await within(area).findByText(/回复正文 21/);
  replies.push(reply(22));
  await user.click(within(area).getByRole('button', { name: '3' }));
  await within(area).findByText(/回复正文 22/);
  await user.click(within(area).getByRole('button', { name: '上一页' }));
  await within(area).findByText(/回复正文 19/);
  await user.click(within(area).getByRole('button', { name: '2' }));
  expect(requests.filter(input => input.page !== undefined).map(input => input.page)).toEqual([1, 2, 3, 3, 2, 2]);
  expect(requests.filter(input => input.page !== undefined).every(input => input.cursor == null)).toBe(true);
});

it('手机楼中楼页码与下一页同样查询最新归档，不依赖首批快照', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 640px)', media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
    removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }));
  const user = userEvent.setup();
  const { reader, replies, requests } = fixture();
  show(reader, '/dynamics/d/comments/root');
  const area = await screen.findByRole('list', { name: '相关回复' });
  await within(area).findByText('回复正文 9');
  const pager = screen.getByRole('navigation', { name: '回复分页' });
  await user.click(within(pager).getByRole('button', { name: '2' }));
  await within(area).findByText('回复正文 19');
  replies.push(reply(21));
  await user.click(within(pager).getByRole('button', { name: '下一页' }));
  await within(area).findByText('回复正文 21');
  replies.push(reply(22));
  await user.click(within(pager).getByRole('button', { name: '3' }));
  await within(area).findByText('回复正文 22');
  expect(requests.map(input => input.page)).toEqual([1, 2, 3, 3]);
  expect(screen.getByRole('article', { name: '被回复的评论' })).toHaveTextContent('当前根评论');
});

it('不轮询新增页，点击当前末页后按最新计数开放下一页', async () => {
  const user = userEvent.setup();
  const { reader, replies, requests } = fixture();
  replies.splice(20);
  show(reader);
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText(/回复正文 0/);
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await within(area).findByText(/回复正文 9/);
  await user.click(within(area).getByRole('button', { name: '2' }));
  await within(area).findByText(/回复正文 19/);
  expect(within(area).getByRole('button', { name: '下一页' })).toBeDisabled();
  const before = requests.length;
  replies.push(reply(20));
  expect(requests).toHaveLength(before);
  await user.click(within(area).getByRole('button', { name: '2' }));
  expect(within(area).getByRole('button', { name: '下一页' })).toBeEnabled();
  await user.click(within(area).getByRole('button', { name: '下一页' }));
  await within(area).findByText(/回复正文 20/);
  expect(requests.filter(input => input.page !== undefined).map(input => input.page)).toEqual([1, 2, 2, 3]);
});

it('桌面收起再展开重新读取第一页，而非重用旧分页内容', async () => {
  const user = userEvent.setup();
  const { reader, requests } = fixture();
  show(reader);
  const area = await screen.findByRole('region', { name: '回复区 root' });
  await within(area).findByText(/回复正文 0/);
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await within(area).findByText(/回复正文 9/);
  await user.click(within(area).getByRole('button', { name: '收起' }));
  await user.click(within(area).getByRole('button', { name: '展开回复' }));
  await within(area).findByText(/回复正文 9/);
  expect(requests.filter(input => input.page !== undefined).map(input => input.page)).toEqual([1, 1]);
});
