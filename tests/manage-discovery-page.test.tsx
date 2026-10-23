import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router';
import { expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import { createManagementApi, type ManagementTransport } from '../src/manage/managementApi';

const reader = createMockReader({ creator: { id: '123', nickname: '测试 UP', avatarUrl: null }, dynamics: [] });
const up = { uid: '123', name: '测试 UP', avatar_url: null, monitor: {
  mode: 'recent', recent_n: 2, enabled: true, last_checked_at: null, last_succeeded_at: null,
} };
const discovery = {
  uid: '123', mode: 'recent', recent_n: 2, enabled: true, active: true,
  status: 'discovered', retryable: false, incomplete: false,
  attempt: { recent_n: 2, started_at: '2025-06-01T02:00:00Z', finished_at: '2025-06-01T02:01:00Z', ids: ['3', '4'], error: null },
  trusted_result: { recent_n: 2, ids: ['3', '4'], exhausted: false, discovered_at: '2025-06-01T02:01:00Z' },
  current_ids: ['3', '4'],
};
function Visits() {
  const navigate = useNavigate();
  return <><button onClick={() => void navigate('/')}>离开管理</button>
    <button onClick={() => void navigate('/manage/ups/123', { state: null })}>新管理访问</button></>;
}
function show(transport: ManagementTransport) {
  return render(<MemoryRouter initialEntries={['/manage/ups/123']}><Visits />
    <App reader={reader} manageApi={createManagementApi(transport)} />
  </MemoryRouter>);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('管理页只手动读取发现窗口，展示实际保存的 N/mode 而不是草稿，窗口就绪不冒充归档成功', async () => {
  const user = userEvent.setup();
  const requests: string[] = [];
  show(async (url, init) => {
    expect(init.method).toBe('GET');
    requests.push(url);
    if (url.endsWith('/discovery')) return Response.json(discovery);
    if (url.endsWith('/targets')) return Response.json({ targets: [] });
    return Response.json({ ups: [up] });
  });
  const card = within(await screen.findByRole('article', { name: 'UP 123' }));
  const panel = within(card.getByRole('region', { name: '近期发现与当前窗口' }));
  expect(requests).toEqual(['/api/manage/ups']);
  expect(panel.getByText('尚未读取发现状态。')).toBeInTheDocument();
  await user.clear(card.getByRole('textbox', { name: '近期 N 条' }));
  await user.type(card.getByRole('textbox', { name: '近期 N 条' }), '99');
  await user.selectOptions(card.getByRole('combobox', { name: '监控模式' }), 'specified');
  expect(card.getByText('已保存模式：近期 N 条；N：2。')).toBeInTheDocument();
  await user.click(panel.getByRole('button', { name: '读取发现状态' }));
  expect(await panel.findByText('本轮发现成功；不代表归档成功。')).toBeInTheDocument();
  expect(panel.getByText('读取时已保存模式：近期 N 条；N：2；监控：已启用。')).toBeInTheDocument();
  expect(panel.getByText('发现窗口已就绪；内容归档请另读检查状态。')).toBeInTheDocument();
  expect(within(panel.getByRole('list', { name: '最近可信发现目标' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['3', '4']);
  expect(within(panel.getByRole('list', { name: '当前启用近期目标' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['3', '4']);
  expect(panel.getByRole('button', { name: '重新读取发现状态' })).toBeEnabled();
  expect(requests).toEqual(['/api/manage/ups', '/api/manage/ups/123/targets', '/api/manage/ups/123/discovery']);
});

it('运行与失败本轮候选不替代旧可信窗口，固定错误和未完成单独展示，重读失败保留旧值且防重复读取', async () => {
  const user = userEvent.setup();
  const pending = deferred<Response>();
  let reads = 0;
  let current: unknown = { ...discovery, status: 'running', retryable: false, incomplete: true,
    attempt: { ...discovery.attempt, ids: ['5'], finished_at: null } };
  show(async (url, init) => {
    expect(init.method).toBe('GET');
    if (!url.endsWith('/discovery')) return Response.json({ ups: [up] });
    reads++;
    return reads === 3 ? pending.promise : Response.json(current);
  });
  const panel = within(await screen.findByRole('region', { name: '近期发现与当前窗口' }));
  await user.click(panel.getByRole('button', { name: '读取发现状态' }));
  expect(await panel.findByText('本轮发现进行中。')).toBeInTheDocument();
  expect(panel.getByText('发现未完成；保留已有可信结果与已发布窗口。')).toBeInTheDocument();
  expect(panel.getByText('本轮完成：未完成')).toBeInTheDocument();
  expect(within(panel.getByRole('list', { name: '本轮累计候选' })).getByText('5')).toBeInTheDocument();
  expect(within(panel.getByRole('list', { name: '最近可信发现目标' })).queryByText('5')).not.toBeInTheDocument();
  expect(within(panel.getByRole('list', { name: '当前启用近期目标' })).getByText('3')).toBeInTheDocument();
  expect(panel.queryByText('发现窗口已就绪；内容归档请另读检查状态。')).not.toBeInTheDocument();
  current = { ...discovery, status: 'failed', retryable: true, incomplete: true,
    attempt: { ...discovery.attempt, ids: ['5'], error: 'PAGINATION_INVALID', message: 'SECRET_TOKEN' } };
  await user.click(panel.getByRole('button', { name: '重新读取发现状态' }));
  expect(await panel.findByText('本轮发现未完整完成。')).toBeInTheDocument();
  expect(panel.getByText('发现错误：分页未完整完成；保留已有可信结果。')).toBeInTheDocument();
  expect(panel.getByText('可在下一固定节拍重试；页面重读不会启动发现。')).toBeInTheDocument();
  await user.click(panel.getByRole('button', { name: '重新读取发现状态' }));
  const button = panel.getByRole('button', { name: '正在读取发现状态…' });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(reads).toBe(3);
  await act(async () => pending.resolve(Response.json({ error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } }, { status: 500 })));
  expect(await panel.findByRole('alert')).toHaveTextContent('管理服务暂不可用');
  expect(panel.getByText('本轮发现未完整完成。')).toBeInTheDocument();
  expect(within(panel.getByRole('list', { name: '当前启用近期目标' })).getByText('3')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  current = discovery;
  await user.click(panel.getByRole('button', { name: '重新读取发现状态' }));
  expect(await panel.findByText('本轮发现成功；不代表归档成功。')).toBeInTheDocument();
  expect(panel.queryByRole('alert')).not.toBeInTheDocument();
});

it('保存配置使旧发现读取失效，忽略取消的迟到成功/失败不覆盖新 N 的窗口或解除新读取锁', async () => {
  const user = userEvent.setup();
  for (const kind of ['success', 'error']) {
    const oldRead = deferred<Response>();
    const newRead = deferred<Response>();
    let oldSignal: AbortSignal | null | undefined;
    let reads = 0;
    const view = show(async (url, init) => {
      if (init.method === 'PATCH') return Response.json({ ...up, monitor: { ...up.monitor, recent_n: 7 } });
      if (!url.endsWith('/discovery')) return Response.json({ ups: [up] });
      reads++;
      if (reads === 1) { oldSignal = init.signal; return oldRead.promise; }
      return newRead.promise;
    });
    const card = within(await screen.findByRole('article', { name: 'UP 123' }));
    await user.click(card.getByRole('button', { name: '读取发现状态' }));
    await user.clear(card.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(card.getByRole('textbox', { name: '近期 N 条' }), '7');
    await user.click(card.getByRole('button', { name: '保存配置' }));
    expect(await card.findByText('已保存模式：近期 N 条；N：7。')).toBeInTheDocument();
    expect(oldSignal?.aborted).toBe(true);
    const panel = within(card.getByRole('region', { name: '近期发现与当前窗口' }));
    expect(panel.getByText('尚未读取发现状态。')).toBeInTheDocument();
    await user.click(panel.getByRole('button', { name: '读取发现状态' }));
    await act(async () => oldRead.resolve(kind === 'success' ? Response.json(discovery)
      : Response.json({ error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } }, { status: 500 })));
    expect(panel.getByRole('button', { name: '正在读取发现状态…' })).toBeDisabled();
    expect(panel.queryByRole('alert')).not.toBeInTheDocument();
    expect(panel.queryByRole('list', { name: '当前启用近期目标' })).not.toBeInTheDocument();
    await act(async () => newRead.resolve(Response.json({ ...discovery, recent_n: 7,
      attempt: { ...discovery.attempt, recent_n: 7, ids: ['6'] },
      trusted_result: { ...discovery.trusted_result, recent_n: 7, ids: ['6'], exhausted: true }, current_ids: ['6'] })));
    expect(panel.getByRole('button', { name: '重新读取发现状态' })).toBeEnabled();
    expect(within(panel.getByRole('list', { name: '当前启用近期目标' })).getByText('6')).toBeInTheDocument();
    expect(panel.queryByText('3')).not.toBeInTheDocument();
    expect(reads).toBe(2);
    view.unmount();
  }
});

it('未发现、首次失败无可信结果、成功空窗口与停用/指定/删除后的历史结果明确区分', async () => {
  const user = userEvent.setup();
  const scenarios = [
    { monitor: up.monitor, data: { ...discovery, status: 'undiscovered', attempt: null,
      trusted_result: null, current_ids: [], retryable: true, incomplete: true },
      status: '尚未开始发现。', trusted: '尚无完整成功的可信发现结果。' },
    { monitor: up.monitor, data: { ...discovery, status: 'failed',
      attempt: { ...discovery.attempt, ids: [], error: 'SOURCE_UNAVAILABLE' },
      trusted_result: null, current_ids: [], retryable: true, incomplete: true },
      status: '本轮发现未完整完成。', trusted: '尚无完整成功的可信发现结果。' },
    { monitor: up.monitor, data: { ...discovery, attempt: { ...discovery.attempt, ids: [] },
      trusted_result: { ...discovery.trusted_result, ids: [], exhausted: true }, current_ids: [] },
      status: '本轮发现成功；不代表归档成功。', trusted: '可信成功空结果；不等于发现失败。' },
    { monitor: { ...up.monitor, enabled: false }, data: { ...discovery, enabled: false, active: false, current_ids: [] },
      status: '本轮发现成功；不代表归档成功。', trusted: '该轮达到 N 后停止扫描；不保证历史已耗尽。' },
    { monitor: { ...up.monitor, mode: 'specified' }, data: { ...discovery, mode: 'specified', active: false, current_ids: [] },
      status: '本轮发现成功；不代表归档成功。', trusted: '该轮达到 N 后停止扫描；不保证历史已耗尽。' },
    { monitor: null, data: { ...discovery, mode: null, recent_n: null, enabled: false,
      active: false, current_ids: [], incomplete: true },
      status: '本轮发现成功；不代表归档成功。', trusted: '该轮达到 N 后停止扫描；不保证历史已耗尽。' },
  ];
  for (const scenario of scenarios) {
    const view = show(async (url, init) => {
      expect(init.method).toBe('GET');
      if (url.endsWith('/discovery')) return Response.json(scenario.data);
      if (url.endsWith('/targets')) return Response.json({ targets: [] });
      return Response.json({ ups: [{ ...up, monitor: scenario.monitor }] });
    });
    const panel = within(await screen.findByRole('region', { name: '近期发现与当前窗口' }));
    await user.click(panel.getByRole('button', { name: '读取发现状态' }));
    expect(await panel.findByText(scenario.status)).toBeInTheDocument();
    expect(panel.getByText(scenario.trusted)).toBeInTheDocument();
    expect(panel.getByText('当前无启用的近期目标；不表示历史归档已删除。')).toBeInTheDocument();
    expect(within(panel.getByRole('list', { name: '当前启用近期目标' })).queryAllByRole('listitem')).toHaveLength(0);
    if (!scenario.data.active) {
      expect(panel.getByText('近期发现当前未启用；历史结果仍可读取。')).toBeInTheDocument();
      expect(within(panel.getByRole('list', { name: '最近可信发现目标' })).getByText('3')).toBeInTheDocument();
      expect(panel.queryByText('发现窗口已就绪；内容归档请另读检查状态。')).not.toBeInTheDocument();
    }
    if (scenario.data.trusted_result?.exhausted) expect(panel.getByText('该轮来源已耗尽；结果保持来源次序。')).toBeInTheDocument();
    expect(panel.queryByRole('alert')).not.toBeInTheDocument();
    view.unmount();
  }
});

it('旧管理访问的迟到成功、HTTP 失败及坏 JSON 不污染新访问，也不提前结束新发现读取', async () => {
  const user = userEvent.setup();
  for (const response of [Response.json(discovery),
    Response.json({ error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } }, { status: 500 }),
    new Response('SECRET_TOKEN')]) {
    const oldRead = deferred<Response>();
    const newRead = deferred<Response>();
    let reads = 0;
    let oldSignal: AbortSignal | null | undefined;
    const view = show(async (url, init) => {
      if (!url.endsWith('/discovery')) return Response.json({ ups: [up] });
      if (++reads === 1) { oldSignal = init.signal; return oldRead.promise; }
      return newRead.promise;
    });
    await user.click(await screen.findByRole('button', { name: '读取发现状态' }));
    await user.click(screen.getByRole('button', { name: '离开管理' }));
    expect(oldSignal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: '新管理访问' }));
    const panel = within(await screen.findByRole('region', { name: '近期发现与当前窗口' }));
    expect(panel.getByText('尚未读取发现状态。')).toBeInTheDocument();
    await user.click(panel.getByRole('button', { name: '读取发现状态' }));
    await act(async () => oldRead.resolve(response));
    expect(panel.getByRole('button', { name: '正在读取发现状态…' })).toBeDisabled();
    expect(panel.queryByRole('alert')).not.toBeInTheDocument();
    expect(panel.queryByRole('list', { name: '当前启用近期目标' })).not.toBeInTheDocument();
    await act(async () => newRead.resolve(Response.json({ ...discovery,
      attempt: { ...discovery.attempt, ids: ['6'] },
      trusted_result: { ...discovery.trusted_result, ids: ['6'], exhausted: true }, current_ids: ['6'] })));
    expect(within(panel.getByRole('list', { name: '当前启用近期目标' })).getByText('6')).toBeInTheDocument();
    expect(panel.queryByText('3')).not.toBeInTheDocument();
    expect(panel.getByRole('button', { name: '重新读取发现状态' })).toBeEnabled();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    view.unmount();
  }
});

it('现有 listChecks 在近期模式也读取当前与移出的历史目标，发现成功不替代检查/归档状态', async () => {
  const user = userEvent.setup();
  const requests: string[] = [];
  const historical = { id: '2', active: false, check_status: 'unchanged',
    last_checked_at: '2025-06-01T02:00:00Z', last_succeeded_at: null,
    observed: {}, revision: 1, work: 'pending', check_error: null, sync_error: 'SYNC_INCOMPLETE',
    synced_version: null, parts: { text: 'pending', media: 'pending', comments: 'pending', replies: 'pending', comment_media: 'pending' } };
  show(async (url, init) => {
    expect(init.method).toBe('GET');
    requests.push(url);
    if (url.endsWith('/discovery')) return Response.json(discovery);
    if (url.endsWith('/checks')) return Response.json({ checks: [historical, { ...historical, id: '3', active: true }] });
    return Response.json({ ups: [up] });
  });
  await user.click(await screen.findByRole('button', { name: '读取发现状态' }));
  expect(await screen.findByText('本轮发现成功；不代表归档成功。')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: '读取检查状态' }));
  const old = within(await screen.findByRole('region', { name: '动态 2 检查状态' }));
  const current = within(screen.getByRole('region', { name: '动态 3 检查状态' }));
  expect(old.getByText('已停止或移出；保留已有归档与未完成工作。')).toBeInTheDocument();
  expect(old.getByText('检查无变化；不代表同步完成。')).toBeInTheDocument();
  expect(old.getByText('实际整轮成功：尚未成功')).toBeInTheDocument();
  expect(current.getByText('已纳入检查')).toBeInTheDocument();
  expect(current.getByText('同步失败，待重试')).toBeInTheDocument();
  expect(requests).toEqual(['/api/manage/ups', '/api/manage/ups/123/discovery', '/api/manage/ups/123/checks']);
});

it('发现的五类持久错误只显示固定说明，HTTP 附加原文不能进入页面', async () => {
  const user = userEvent.setup();
  let error = 'SOURCE_UNAVAILABLE';
  show(async url => url.endsWith('/discovery') ? Response.json({ ...discovery,
    status: 'failed', incomplete: true, retryable: true,
    attempt: { ...discovery.attempt, error, message: 'SECRET_TOKEN', offset: 'SECRET_TOKEN' },
    message: 'SECRET_TOKEN',
  }) : Response.json({ ups: [up] }));
  const panel = within(await screen.findByRole('region', { name: '近期发现与当前窗口' }));
  const errors = [
    { code: 'SOURCE_UNAVAILABLE', message: '来源暂不可用；保留已有可信结果。' },
    { code: 'SIGNAL_INVALID', message: '发现响应解析失败；保留已有可信结果。' },
    { code: 'PAGINATION_INVALID', message: '分页未完整完成；保留已有可信结果。' },
    { code: 'DISCOVERY_STOPPED', message: '配置已改变，本轮发现已停止。' },
    { code: 'DISCOVERY_INTERRUPTED', message: '发现进程中断，本轮未完成。' },
  ];
  for (const { code, message } of errors) {
    error = code;
    await user.click(panel.getByRole('button', { name: /^(读取|重新读取)发现状态$/ }));
    expect(await panel.findByText(`发现错误：${message}`)).toBeInTheDocument();
    expect(panel.getByText('发现未完成；保留已有可信结果与已发布窗口。')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
  }
});

it('停留多个采集节拍不会自动读取发现或检查，只有显式重读才增加管理 GET', async () => {
  vi.useFakeTimers();
  try {
    const requests: string[] = [];
    await act(async () => {
      show(async (url, init) => {
        expect(init.method).toBe('GET');
        requests.push(url);
        return url.endsWith('/discovery') ? Response.json(discovery) : Response.json({ ups: [up] });
      });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(requests).toEqual(['/api/manage/ups']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取发现状态' })); });
    expect(screen.getByText('本轮发现成功；不代表归档成功。')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(requests).toEqual(['/api/manage/ups', '/api/manage/ups/123/discovery']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新读取发现状态' })); });
    expect(requests).toEqual(['/api/manage/ups', '/api/manage/ups/123/discovery', '/api/manage/ups/123/discovery']);
  } finally { vi.useRealTimers(); }
});
