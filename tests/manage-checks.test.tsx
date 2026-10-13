import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import { createManagementApi } from '../src/manage/managementApi';

const signal = new AbortController().signal;
const check = {
  id: '900719925474099312345', active: true, check_status: 'unchanged',
  last_checked_at: '2025-06-01T02:00:00Z', last_succeeded_at: null,
  observed: { observed_version: 'edit:2025-06-01T10:00+08:00', edit_status: 'observed' },
  revision: 2, work: 'pending', check_error: null, sync_error: 'SYNC_INCOMPLETE',
  synced_version: 'edit:2025-06-01T09:00+08:00',
  parts: { text: 'pending', media: 'pending', comments: 'success', replies: 'success', comment_media: 'success' },
};
const up = { uid: '123', name: '测试 UP', avatar_url: null, monitor: {
  mode: 'specified', recent_n: 10, enabled: true, last_checked_at: null, last_succeeded_at: null,
} };
const reader = createMockReader({ creator: { id: '123', nickname: '测试 UP', avatarUrl: null }, dynamics: [] });

describe('目标检查生产映射', () => {
  it('独立映射观察和实际成功版本，不把无变化或旧正文成功当成新版本已完成', async () => {
    const api = createManagementApi(async (url, init) => {
      expect(url).toBe('/api/manage/ups/123/checks');
      expect(init.method).toBe('GET');
      expect(init.signal).toBe(signal);
      return Response.json({ checks: [check] });
    });
    expect(await api.listChecks({ uid: '123', signal })).toMatchObject({ status: 'success', data: [{
      id: check.id, active: true, checkStatus: 'unchanged', work: 'pending', revision: 2,
      observedVersion: check.observed.observed_version, syncedVersion: check.synced_version,
      lastCheckedAt: '2025-06-01T02:00:00Z', lastSucceededAt: null,
      parts: { text: 'pending', media: 'pending' }, syncError: 'SYNC_INCOMPLETE',
    }] });
  });
  it('管理页展示分项及较新版本待同步，手动读取不执行同步', async () => {
    const user = userEvent.setup();
    let current: unknown = check;
    const urls: string[] = [];
    const api = createManagementApi(async (url, init) => {
      urls.push(url);
      expect(init.method).toBe('GET');
      if (url.endsWith('/checks')) return Response.json({ checks: [current] });
      if (url.endsWith('/targets')) return Response.json({ targets: [{ id: check.id }] });
      return Response.json({ ups: [up] });
    });
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const status = within(await screen.findByRole('region', { name: `动态 ${check.id} 检查状态` }));
    expect(status.getByText('检查无变化；不代表同步完成。')).toBeInTheDocument();
    expect(status.getByText('观察与正文成功版本不一致；当前观察仍待同步确认。')).toBeInTheDocument();
    expect(status.getByText('部分完成')).toBeInTheDocument();
    expect(status.getByText('正文待处理；动态图待处理；评论已保存；回复已保存；评论图已保存。')).toBeInTheDocument();
    expect(status.getByText('实际整轮成功：尚未成功')).toBeInTheDocument();
    current = { ...check, work: 'running', sync_error: null,
      synced_version: check.observed.observed_version, parts: { ...check.parts, text: 'success' } };
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await status.findByText('同步中')).toBeInTheDocument();
    expect(status.getByText('正文已保存；动态图待处理；评论已保存；回复已保存；评论图已保存。')).toBeInTheDocument();
    expect(urls.every(url => url.startsWith('/api/manage/'))).toBe(true);
  });
  it('未检查、未知信号、失败与停用记录不冒充成功，错误只显示固定提示', async () => {
    const user = userEvent.setup();
    const api = createManagementApi(async url => url.endsWith('/checks') ? Response.json({ checks: [
      { ...check, id: '1', check_status: 'unchecked', revision: 0, observed: {}, synced_version: null,
        sync_error: null, last_checked_at: null, parts: { text: 'pending', media: 'pending', comments: 'pending', replies: 'pending', comment_media: 'pending' } },
      { ...check, id: '2', active: false, check_status: 'failed', observed: { ...check.observed, edit_status: 'error', secret: 'SECRET_TOKEN' },
        check_error: 'SIGNAL_INVALID', sync_error: 'SOURCE_UNAVAILABLE' },
    ] }) : Response.json({ ups: [{ ...up, monitor: { ...up.monitor, mode: 'recent', enabled: false } }] }));
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const unchecked = within(await screen.findByRole('region', { name: '动态 1 检查状态' }));
    expect(screen.getByText('最近成功：尚未成功')).toBeInTheDocument();
    expect(unchecked.getByText('未检查')).toBeInTheDocument();
    expect(unchecked.getByText('尚无检查工作')).toBeInTheDocument();
    expect(unchecked.getByText('编辑信号未知；不代表确认未编辑。')).toBeInTheDocument();
    const failed = within(screen.getByRole('region', { name: '动态 2 检查状态' }));
    expect(failed.getByText('检查失败')).toBeInTheDocument();
    expect(failed.getByText('已停止或移出；保留已有归档与未完成工作。')).toBeInTheDocument();
    expect(failed.getByText('同步：来源暂不可用。')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  });
  it('成功时间来自实际执行；读取失败保留旧状态并可原位重试', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const api = createManagementApi(async url => {
      if (!url.endsWith('/checks')) return Response.json({ ups: [{ ...up, monitor: null }] });
      reads++;
      if (reads === 2) return new Response('SECRET_TOKEN', { status: 500 });
      return Response.json({ checks: [{ ...check, active: false, work: 'complete',
        synced_version: check.observed.observed_version, sync_error: null,
        last_succeeded_at: '2025-06-01T02:01:00Z', parts: { ...check.parts, text: 'success', media: 'success' } }] });
    });
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    const status = within(await screen.findByRole('region', { name: `动态 ${check.id} 检查状态` }));
    expect(status.getByText('对应观察已完成')).toBeInTheDocument();
    expect(status.getByText('实际整轮成功：2025-06-01 10:01:00')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('管理接口响应异常');
    expect(status.getByText('对应观察已完成')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    await user.click(screen.getByRole('button', { name: '重新读取检查状态' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('忽略取消的旧状态读取不能污染重新进入的管理页', async () => {
    const user = userEvent.setup();
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    let oldSignal: AbortSignal | null | undefined;
    const api = createManagementApi(async (url, init) => {
      if (url.endsWith('/checks')) { oldSignal = init.signal; return pending; }
      return Response.json({ ups: [{ ...up, monitor: { ...up.monitor, mode: 'recent' } }] });
    });
    const view = render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: '读取检查状态' }));
    view.unmount();
    expect(oldSignal?.aborted).toBe(true);
    render(<MemoryRouter initialEntries={['/manage']}><App reader={reader} manageApi={api} /></MemoryRouter>);
    await screen.findByRole('button', { name: '读取检查状态' });
    await act(async () => resolve(Response.json({ checks: [check] })));
    expect(screen.getByText('尚未读取检查状态。')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: `动态 ${check.id} 检查状态` })).not.toBeInTheDocument();
  });
  it('拒绝非法、重复状态与未知错误码；取消和 HTTP 错误不泄漏原文', async () => {
    for (const body of [null, { checks: [check, check] }, ...[
      { id: 123 }, { active: 'true' }, { revision: 1.5 }, { work: 'SECRET_TOKEN' },
      { check_status: 'SECRET_TOKEN' }, { observed: null }, { synced_version: 1 },
      { last_checked_at: '2025-02-30T02:00:00Z' }, { sync_error: 'SECRET_TOKEN' },
      { parts: { ...check.parts, media: 'SECRET_TOKEN' } },
    ].map(overrides => ({ checks: [{ ...check, ...overrides }] }))]) {
      const result = await createManagementApi(async () => Response.json(body)).listChecks({ uid: '123', signal });
      expect(result).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
      expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    }
    const controller = new AbortController();
    const api = createManagementApi(async () => {
      controller.abort();
      return Response.json({ checks: [check] });
    });
    expect(await api.listChecks({ uid: '123', signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(await createManagementApi(async () => Response.json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 502 }))
      .listChecks({ uid: '123', signal })).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
  });
});
