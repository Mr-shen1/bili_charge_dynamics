import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createArchiveReader } from '../src/data/archiveReader';
import { createManagementApi } from '../src/manage/managementApi';
import { archive } from './fixtures/archive';
function Visits() {
  const navigate = useNavigate();
  return <><button onClick={() => void navigate('/')}>离开管理</button>
    <button onClick={() => void navigate('/manage/ups/123', { state: null })}>新管理访问</button></>;
}
const up = { uid: '123', name: '归档作者', avatar_url: null, monitor: { mode: 'specified', recent_n: 10, enabled: true,
  last_checked_at: null, last_succeeded_at: null } };
const id = '900719925474099312345';
describe('管理指定目标', () => {
  it('StrictMode 下取消旧目标读取，忽略取消的旧集合不覆盖当前列表', async () => {
    let reads = 0;
    let resolve!: (response: Response) => void;
    const deferred = new Promise<Response>(done => { resolve = done; });
    let oldSignal: AbortSignal | null | undefined;
    const api = createManagementApi(async (url, init) => {
      if (url === '/api/manage/ups') return Response.json({ ups: [up] });
      if (++reads === 1) { oldSignal = init.signal; return deferred; }
      return Response.json({ targets: [{ id: '456' }] });
    });
    render(<StrictMode><MemoryRouter initialEntries={['/manage/ups/123']}><App manageApi={api}
      reader={createArchiveReader(async () => Response.json({ items: [], next_cursor: null }))} /></MemoryRouter></StrictMode>);
    const card = within(await screen.findByRole('article', { name: 'UP 123' }));
    await card.findByRole('button', { name: '移除目标 456' });
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolve(Response.json({ targets: [{ id }] })));
    expect(card.getByRole('button', { name: '移除目标 456' })).toBeInTheDocument();
    expect(card.queryByRole('button', { name: `移除目标 ${id}` })).not.toBeInTheDocument();
  });
  it.each(['success', 'error'] as const)('同 UID 添加连点防重、离开会取消，忽略取消的旧 %s 不污染新访问', async kind => {
    const user = userEvent.setup();
    let resolve!: (response: Response) => void;
    const deferred = new Promise<Response>(done => { resolve = done; });
    let posts = 0;
    let oldSignal: AbortSignal | null | undefined;
    const api = createManagementApi(async (url, init) => {
      if (url === '/api/manage/ups') return Response.json({ ups: [up] });
      if (init.method === 'GET') return Response.json({ targets: [] });
      posts++; oldSignal = init.signal; return deferred;
    });
    render(<MemoryRouter initialEntries={['/manage/ups/123']}><Visits /><App manageApi={api}
      reader={createArchiveReader(async () => Response.json({ items: [], next_cursor: null }))} /></MemoryRouter>);
    let card = within(await screen.findByRole('article', { name: 'UP 123' }));
    await card.findByText('尚未添加指定目标。');
    await user.type(card.getByRole('textbox', { name: '动态 ID' }), id);
    await user.dblClick(card.getByRole('button', { name: '校验并添加目标' }));
    fireEvent.submit(card.getByRole('textbox', { name: '动态 ID' }).closest('form')!);
    expect(posts).toBe(1);
    expect(card.getByRole('button', { name: '正在校验…' })).toBeDisabled();
    expect(card.getByRole('button', { name: '删除监控配置' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '离开管理' }));
    expect(oldSignal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: '新管理访问' }));
    card = within(await screen.findByRole('article', { name: 'UP 123' }));
    await card.findByText('尚未添加指定目标。');
    await user.type(card.getByRole('textbox', { name: '动态 ID' }), '456');
    await act(async () => resolve(kind === 'success' ? Response.json({ id }, { status: 201 })
      : Response.json({ error: { code: 'TARGET_UNVERIFIED', message: 'SECRET_TOKEN' } }, { status: 502 })));
    expect(card.getByRole('textbox', { name: '动态 ID' })).toHaveValue('456');
    expect(card.getByRole('button', { name: '校验并添加目标' })).toBeEnabled();
    expect(card.queryByRole('alert')).not.toBeInTheDocument();
    expect(card.queryByText('归属校验通过，目标关联已保存。')).not.toBeInTheDocument();
  });
  it('目标列表失败可重试、删除失败保留目标；删除连点只请求一次', async () => {
    const user = userEvent.setup();
    let reads = 0; let deletes = 0;
    let resolve!: (response: Response) => void;
    const deferred = new Promise<Response>(done => { resolve = done; });
    const api = createManagementApi(async (url, init) => {
      if (url === '/api/manage/ups') return Response.json({ ups: [up] });
      if (init.method === 'GET') return ++reads === 1 ? new Response('SECRET_TOKEN') : Response.json({ targets: [{ id }] });
      deletes++;
      return deletes === 1 ? Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 }) : deferred;
    });
    render(<MemoryRouter initialEntries={['/manage/ups/123']}><App manageApi={api}
      reader={createArchiveReader(async () => Response.json({ items: [], next_cursor: null }))} /></MemoryRouter>);
    const card = within(await screen.findByRole('article', { name: 'UP 123' }));
    expect(await card.findByRole('alert')).toHaveTextContent('管理接口响应异常');
    expect(card.queryByText('尚未添加指定目标。')).not.toBeInTheDocument();
    await user.click(card.getByRole('button', { name: '重试读取目标' }));
    await user.click(await card.findByRole('button', { name: `移除目标 ${id}` }));
    expect(await card.findByRole('alert')).toHaveTextContent('配置存储暂不可用');
    expect(card.getByText(id)).toBeInTheDocument();
    await user.dblClick(card.getByRole('button', { name: `移除目标 ${id}` }));
    expect(deletes).toBe(2);
    expect(card.getByText(id)).toBeInTheDocument();
    await act(async () => resolve(new Response(null, { status: 204 })));
    expect(card.getByText('目标已移除；已有归档保留。')).toBeInTheDocument();
    expect(card.queryByText(id)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  });
  it('归属不符/未知不添加，正确添加与移除后新管理访问读取持久结果；删除不影响归档', async () => {
    const user = userEvent.setup();
    let targets: { id: string }[] = [];
    let posts = 0;
    const api = createManagementApi(async (url, init) => {
      if (url === '/api/manage/ups') return Response.json({ ups: [up] });
      expect(url).toBe(`/api/manage/ups/123/targets${init.method === 'DELETE' ? `/${id}` : ''}`);
      if (init.method === 'GET') return Response.json({ targets });
      if (init.method === 'POST') {
        expect(init.body).toBe(`{"id":"${id}"}`);
        posts++;
        if (posts < 3) return Response.json({ error: { code: posts === 1 ? 'TARGET_AUTHOR_MISMATCH' : 'TARGET_UNVERIFIED', message: 'SECRET_TOKEN' } }, { status: posts === 1 ? 409 : 502 });
        targets = [{ id }]; return Response.json({ id }, { status: 201 });
      }
      targets = []; return new Response(null, { status: 204 });
    });
    function show() { return render(<MemoryRouter initialEntries={['/manage/ups/123']}><App
      reader={createArchiveReader(async () => Response.json({ items: [archive], next_cursor: null }))} manageApi={api} /></MemoryRouter>); }
    let view = show();
    let card = within(await screen.findByRole('article', { name: 'UP 123' }));
    await card.findByText('尚未添加指定目标。');
    const input = card.getByRole('textbox', { name: '动态 ID' });
    await user.type(input, '01');
    await user.click(card.getByRole('button', { name: '校验并添加目标' }));
    expect(card.getByRole('alert')).toHaveTextContent('动态 ID 须为'); expect(posts).toBe(0);
    await user.clear(input); await user.type(input, id);
    for (const message of ['动态作者与所选 UP 不符。', '无法确认动态归属。']) {
      await user.click(card.getByRole('button', { name: /校验并添加目标|重试添加目标/ }));
      expect(await card.findByRole('alert')).toHaveTextContent(message);
      expect(card.queryByRole('button', { name: `移除目标 ${id}` })).not.toBeInTheDocument();
      expect(input).toHaveValue(id);
    }
    await user.click(card.getByRole('button', { name: '重试添加目标' }));
    expect(await card.findByText('归属校验通过，目标关联已保存。')).toBeInTheDocument();
    expect(input).toHaveValue('');
    view.unmount(); view = show();
    card = within(await screen.findByRole('article', { name: 'UP 123' }));
    await user.click(await card.findByRole('button', { name: `移除目标 ${id}` }));
    expect(await card.findByText('目标已移除；已有归档保留。')).toBeInTheDocument();
    view.unmount(); show();
    card = within(await screen.findByRole('article', { name: 'UP 123' }));
    expect(await card.findByText('尚未添加指定目标。')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    await user.click(screen.getByRole('link', { name: '返回阅读' }));
    expect(await screen.findByText(archive.text.replace(/\s+/g, ' '))).toBeInTheDocument();
  });
});
