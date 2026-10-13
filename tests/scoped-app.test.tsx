import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createArchiveReader } from '../src/data/archiveReader';
import { createMockReader } from '../src/data/mockReader';
import { createControlledReader } from '../src/dev/controlledReader';
import type { DynamicBatch, ReadResult } from '../src/data/contracts';
import { archive } from './fixtures/archive';

const one = { id: '123', nickname: '保留作者一', avatarUrl: null };
const two = { id: '456', nickname: '保留作者二', avatarUrl: null };
function show(reader: ReturnType<typeof createArchiveReader>, path = '/') {
  return render(<MemoryRouter initialEntries={[path]}><App reader={reader} /></MemoryRouter>);
}
describe('全部与单 UP 最小路由', () => {
  it('单 UP 追加失败保留原 cursor，连点只读一次，重试同批，结束不继续请求', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    let failed = false;
    const reader = createArchiveReader(async url => {
      if (url.endsWith('/ups')) return Response.json({ ups: [] });
      requests.push(url);
      if (url.includes('cursor=') && !failed) { failed = true; throw new Error('SECRET'); }
      return Response.json({ items: [{ ...archive, id: url.includes('cursor=') ? '9002' : archive.id, text: url.includes('cursor=') ? '单 UP 第二批' : '单 UP 首批' }],
        next_cursor: url.includes('cursor=') ? null : 'same-batch' });
    });
    show(reader, '/ups/123');
    await screen.findByText('单 UP 首批');
    await user.dblClick(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('动态追加读取失败');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('单 UP 第二批');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('动态已加载完毕')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '加载更多' })).not.toBeInTheDocument();
    expect(requests).toEqual(['/api/archive/dynamics?limit=10&scope=up&uid=123', '/api/archive/dynamics?limit=10&scope=up&uid=123&cursor=same-batch',
      '/api/archive/dynamics?limit=10&scope=up&uid=123&cursor=same-batch']);
  });
  it.each(['success', 'error', 'throw', 'cancelled'] as const)('忽略取消的旧 %s/完成不能污染新 scope 或清掉其加载态', async kind => {
    let finishOld!: (value: ReadResult<DynamicBatch>) => void;
    let rejectOld!: (reason: Error) => void;
    let finishNew!: (value: ReadResult<DynamicBatch>) => void;
    const old = new Promise<ReadResult<DynamicBatch>>((resolve, reject) => { finishOld = resolve; rejectOld = reject; });
    const fresh = new Promise<ReadResult<DynamicBatch>>(resolve => { finishNew = resolve; });
    const base = createMockReader({ creator: one, identities: [two], dynamics: [] });
    const reader = createControlledReader(base, { list: [{ result: old, ignoreAbort: true }, { result: fresh }] });
    const user = userEvent.setup();
    show(reader, '/ups/123');
    await user.click(await screen.findByRole('link', { name: two.nickname }));
    expect(screen.getByText('动态列表加载中…')).toBeInTheDocument();
    await act(async () => {
      if (kind === 'throw') rejectOld(new Error('SECRET'));
      else finishOld(kind === 'success' ? { status: 'success', data: { items: [{ id: '1', author: one, publishedAt: null, text: '旧 scope 正文', commentCount: 0 }], nextCursor: null } }
        : { status: kind });
    });
    expect(screen.getByText('动态列表加载中…')).toBeInTheDocument();
    expect(screen.queryByText('旧 scope 正文')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { finishNew({ status: 'success', data: { items: [{ id: '2', author: two, publishedAt: null, text: '新 scope 正文', commentCount: 0 }], nextCursor: null } }); });
    expect(await screen.findByText('新 scope 正文')).toBeInTheDocument();
    expect(screen.getByText('动态已加载完毕')).toBeInTheDocument();
  });
  it('cursor 失效保留旧批并明确重新开始，不把错误当结束', async () => {
    const user = userEvent.setup();
    const requests: string[] = [];
    const reader = createArchiveReader(async url => {
      if (url.endsWith('/ups')) return Response.json({ ups: [] });
      requests.push(url);
      if (url.includes('cursor=')) return Response.json({ error: { code: 'INVALID_INPUT' } }, { status: 422 });
      return Response.json({ items: [{ ...archive, text: requests.length > 2 ? '重新开始的新归档' : '旧首批' }], next_cursor: 'expired' });
    });
    show(reader);
    await screen.findByText('旧首批');
    await user.click(screen.getByRole('button', { name: '加载更多' }));
    await screen.findByText('分页已失效，请重新开始读取。');
    expect(screen.getByText('旧首批')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新开始' }));
    await screen.findByText('重新开始的新归档');
    expect(screen.queryByText('旧首批')).not.toBeInTheDocument();
    expect(requests).toEqual(['/api/archive/dynamics?limit=10&scope=all', '/api/archive/dynamics?limit=10&scope=all&cursor=expired', '/api/archive/dynamics?limit=10&scope=all']);
  });
  it('未知 UP、已知空、动态不存在、未知路由和网络失败分别表达', async () => {
    const reader = createMockReader({ creator: one, identities: [two], dynamics: [] });
    let view = show(reader, '/ups/999');
    await screen.findByText('UP 不存在');
    expect(screen.queryByText('暂无动态')).not.toBeInTheDocument();
    view.unmount();
    view = show(reader, '/ups/456');
    await screen.findByText('暂无动态');
    expect(screen.queryByText('UP 不存在')).not.toBeInTheDocument();
    view.unmount();
    view = show(reader, '/dynamics/999');
    await screen.findByText('动态不存在或不可用');
    view.unmount();
    view = show(reader, '/invalid');
    await screen.findByRole('heading', { name: '未找到页面' });
    view.unmount();
    show(createArchiveReader(async () => { throw new Error('SECRET'); }), '/ups/456');
    expect(await screen.findByRole('alert')).toHaveTextContent('动态列表读取失败');
    expect(document.body).not.toHaveTextContent('SECRET');
  });
  it('直接打开单 UP，作者导航到全部和另一 UP，数据互不串用，详情返回其来源列表', async () => {
    const requests: string[] = [];
    const reader = createArchiveReader(async url => {
      requests.push(url);
      if (url.endsWith('/ups')) return Response.json({ ups: [one, two].map(user => ({ id: user.id, nickname: user.nickname, avatar_url: null })) });
      if (!url.includes('?')) return Response.json(archive);
      const uid = new URL(url, 'http://local').searchParams.get('uid');
      const first = { ...archive, text: '作者一的归档' };
      const second = { ...archive, id: '9002', author: { id: '456', nickname: two.nickname, avatar_url: null }, text: '作者二的归档' };
      return Response.json({ items: uid === '123' ? [first] : uid === '456' ? [second] : [first, second], next_cursor: null });
    });
    const user = userEvent.setup();
    show(reader, '/ups/123');
    await screen.findByText('作者一的归档');
    expect(screen.queryByText('作者二的归档')).not.toBeInTheDocument();
    const nav = within(await screen.findByRole('navigation', { name: '归档范围' }));
    await user.click(nav.getByRole('link', { name: '保留作者二' }));
    await screen.findByText('作者二的归档');
    expect(screen.queryByText('作者一的归档')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '全部归档' }));
    await screen.findByText('作者一的归档');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    await user.click(screen.getByRole('link', { name: '保留作者一' }));
    await screen.findByText('作者一的归档');
    await user.click(screen.getByRole('button', { name: '查看详情' }));
    await screen.findByRole('heading', { name: '动态详情' });
    await user.click(screen.getByRole('button', { name: '返回列表' }));
    await screen.findByText('作者一的归档');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(requests).toContain('/api/archive/dynamics?limit=10&scope=up&uid=123');
    expect(requests).toContain('/api/archive/dynamics?limit=10&scope=up&uid=456');
    expect(requests).toContain('/api/archive/dynamics?limit=10&scope=all');
  });
});
