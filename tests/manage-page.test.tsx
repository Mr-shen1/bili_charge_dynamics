import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/app/App';
import { createMockReader } from '../src/data/mockReader';
import { createManagementApi, type ManagementTransport } from '../src/manage/managementApi';

const reader = createMockReader({ creator: { id: 'reader', nickname: '阅读者', avatarUrl: null }, dynamics: [] });
const up = (uid: string, name = `用户 ${uid}`) => ({ uid, name, avatar_url: 'https://example.test/avatar.png',
  monitor: { mode: 'recent', recent_n: 10, enabled: true, last_checked_at: null, last_succeeded_at: null } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function Visits() {
  const navigate = useNavigate();
  return <><button onClick={() => void navigate('/')}>离开管理</button>
    <button onClick={() => void navigate('/manage', { state: null })}>新管理访问</button></>;
}
function show(transport?: ManagementTransport) {
  return render(<MemoryRouter initialEntries={['/manage']}><Visits />
    <App reader={reader} {...(transport ? { manageApi: createManagementApi(transport) } : {})} />
  </MemoryRouter>);
}

describe('/manage 生产映射页面', () => {
  it('UID 与近期 N 校验失败不发请求；非法成功 JSON 保留该卡草稿而非显示保存成功', async () => {
    const user = userEvent.setup();
    let mutations = 0;
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [up('123')] });
      mutations++;
      return Response.json({ ...up('123'), monitor: { mode: 'recent', recent_n: '21', enabled: true } });
    });
    const a = within(await screen.findByRole('article', { name: 'UP 123' }));
    const uidInput = screen.getByRole('textbox', { name: 'UP UID' });
    for (const uid of [' 123', '0123', '1e3']) {
      await user.clear(uidInput); await user.type(uidInput, uid);
      await user.click(screen.getByRole('button', { name: '添加监控' }));
      expect(screen.getByRole('alert')).toHaveTextContent('UID 须为');
      expect(uidInput).toHaveValue(uid);
    }
    await user.clear(uidInput);
    const n = a.getByRole('textbox', { name: '近期 N 条' });
    for (const value of ['0', '1e2', '9007199254740992']) {
      await user.clear(n); await user.type(n, value);
      await user.click(a.getByRole('button', { name: '保存配置' }));
      expect(a.getByRole('alert')).toHaveTextContent('近期 N 须为');
    }
    expect(mutations).toBe(0);
    await user.clear(n); await user.type(n, '21');
    await user.click(a.getByRole('button', { name: '保存配置' }));
    expect(await a.findByRole('alert')).toHaveTextContent('管理接口响应异常');
    expect(n).toHaveValue('21');
    expect(a.queryByText('保存成功。')).not.toBeInTheDocument();
    expect(a.getByRole('button', { name: '重试保存' })).toBeEnabled();
  });
  it.each(['success', 'error'] as const)('忽略取消的旧保存 %s 不污染新页面访问或另一 UP', async kind => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    let oldSignal: AbortSignal | null | undefined;
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [up('123'), up('456')] });
      oldSignal = init.signal;
      return pending.promise;
    });
    let a = within(await screen.findByRole('article', { name: 'UP 123' }));
    await user.clear(a.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(a.getByRole('textbox', { name: '近期 N 条' }), '21');
    await user.click(a.getByRole('button', { name: '保存配置' }));
    await user.click(screen.getByRole('button', { name: '离开管理' }));
    expect(oldSignal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: '新管理访问' }));
    a = within(await screen.findByRole('article', { name: 'UP 123' }));
    const b = within(screen.getByRole('article', { name: 'UP 456' }));
    await user.clear(a.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(a.getByRole('textbox', { name: '近期 N 条' }), '55');
    await act(async () => pending.resolve(kind === 'success'
      ? Response.json({ ...up('123'), monitor: { ...up('123').monitor, recent_n: 21 } })
      : Response.json({ error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } }, { status: 500 })));
    expect(a.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('55');
    expect(b.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');
    expect(a.getByRole('button', { name: '保存配置' })).toBeEnabled();
    expect(screen.queryByText('保存成功。')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('忽略取消的旧读取不覆盖新管理访问的身份集合', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    let reads = 0;
    show(async () => ++reads === 1 ? pending.promise : Response.json({ ups: [up('456')] }));
    await user.click(screen.getByRole('button', { name: '新管理访问' }));
    expect(await screen.findByRole('article', { name: 'UP 456' })).toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({ ups: [up('123')] })));
    expect(screen.queryByRole('article', { name: 'UP 123' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'UP 456' })).toBeInTheDocument();
  });

  it('坏 JSON 读取可原位重试，头像加载失败兜底且恶意昵称只作文字', async () => {
    const user = userEvent.setup();
    let reads = 0;
    show(async () => ++reads === 1 ? new Response('SECRET_TOKEN')
      : Response.json({ ups: [up('123', '<img src=x onerror=alert(1)>'), up('456')] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('管理接口响应异常');
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    const a = within(await screen.findByRole('article', { name: 'UP 123' }));
    expect(a.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    const avatar = a.getByRole('img');
    fireEvent.error(avatar);
    expect(avatar).toHaveAttribute('src', '/default-avatar.svg');
    expect(a.getAllByRole('img')).toHaveLength(1);
    expect(within(screen.getByRole('article', { name: 'UP 456' })).getByRole('img')).toHaveAttribute('src', 'https://example.test/avatar.png');
  });
  it('删除失败保留草稿，删除仅配置后身份保留；重新添加失败保留身份且同 UID 防重', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    let deletes = 0; let adds = 0;
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [up('123'), up('456')] });
      if (init.method === 'DELETE') {
        deletes++;
        return deletes === 1 ? Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 })
          : new Response(null, { status: 204 });
      }
      adds++;
      return adds === 1 ? pending.promise : Response.json(up('123'), { status: 201 });
    });
    let a = within(await screen.findByRole('article', { name: 'UP 123' }));
    await user.clear(a.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(a.getByRole('textbox', { name: '近期 N 条' }), '37');
    await user.click(a.getByRole('button', { name: '删除监控配置' }));
    expect(await a.findByRole('alert')).toHaveTextContent('配置存储暂不可用');
    expect(a.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('37');
    await user.click(a.getByRole('button', { name: '重试删除' }));
    expect(await screen.findByText('监控配置已删除；身份和已有归档保留。')).toBeInTheDocument();
    a = within(screen.getByRole('article', { name: 'UP 123' }));
    expect(a.getByText('用户 123')).toBeInTheDocument();
    expect(a.queryByRole('combobox')).not.toBeInTheDocument();
    const uidInput = screen.getByRole('textbox', { name: 'UP UID' });
    await user.type(uidInput, '123');
    await user.click(a.getByRole('button', { name: '重新添加监控' }));
    expect(a.getByRole('button', { name: '正在重新添加…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '正在添加…' })).toBeDisabled();
    fireEvent.submit(uidInput.closest('form')!);
    expect(adds).toBe(1);
    await act(async () => pending.resolve(Response.json({ error: { code: 'PROFILE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 502 })));
    expect(await a.findByRole('alert')).toHaveTextContent('未取得 UP 资料');
    expect(a.getByText('用户 123')).toBeInTheDocument();
    await user.click(a.getByRole('button', { name: '重试重新添加' }));
    a = within(screen.getByRole('article', { name: 'UP 123' }));
    expect(await a.findByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(within(screen.getByRole('article', { name: 'UP 456' })).getByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');
  });
  it('启停只使用该 UP 已保存配置，失败原位重试，既不提交也不丢失未保存草稿', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const bodies: unknown[] = [];
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [up('123'), up('456')] });
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return pending.promise;
      return Response.json({ ...up('123'), monitor: { ...up('123').monitor,
        recent_n: bodies.length === 2 ? 10 : 31, enabled: false } });
    });
    const a = within(await screen.findByRole('article', { name: 'UP 123' }));
    const b = within(screen.getByRole('article', { name: 'UP 456' }));
    const n = a.getByRole('textbox', { name: '近期 N 条' });
    await user.clear(n); await user.type(n, '31');
    await user.click(a.getByRole('button', { name: '停止监控' }));
    expect(a.getByRole('button', { name: '正在停止…' })).toBeDisabled();
    expect(a.getByRole('button', { name: '保存配置' })).toBeDisabled();
    expect(b.getByRole('button', { name: '停止监控' })).toBeEnabled();
    await act(async () => pending.resolve(Response.json({ error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } }, { status: 500 })));
    expect(await a.findByRole('alert')).toHaveTextContent('管理服务暂不可用');
    expect(a.getByText('监控：已启用')).toBeInTheDocument();
    expect(n).toHaveValue('31');
    await user.click(a.getByRole('button', { name: '重试停止' }));
    expect(await a.findByText('监控：已停止')).toBeInTheDocument();
    expect(n).toHaveValue('31');
    expect(b.getByText('监控：已启用')).toBeInTheDocument();
    await user.click(a.getByRole('button', { name: '保存配置' }));
    expect(await a.findByText('保存成功。')).toBeInTheDocument();
    expect(bodies).toEqual([
      { mode: 'recent', recent_n: 10, enabled: false },
      { mode: 'recent', recent_n: 10, enabled: false },
      { mode: 'recent', recent_n: 31, enabled: false },
    ]);
  });
  it('两 UP 草稿独立、互斥模式可键盘保存；一张卡保存失败及阻塞不锁另一张卡', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    let firstSaves = 0;
    const writes: { url: string; body: unknown }[] = [];
    show(async (url, init) => {
      if (url.endsWith('/targets') && init.method === 'GET') return Response.json({ targets: [] });
      if (init.method === 'GET') return Response.json({ ups: [up('123'), up('456')] });
      const body: unknown = JSON.parse(String(init.body));
      writes.push({ url, body });
      if (url.includes('/123/')) {
        firstSaves++;
        if (firstSaves === 1) return pending.promise;
        return Response.json({ ...up('123'), monitor: { ...up('123').monitor, recent_n: 101 } });
      }
      return Response.json({ ...up('456'), monitor: { ...up('456').monitor, mode: 'specified', recent_n: 27 } });
    });
    const a = within(await screen.findByRole('article', { name: 'UP 123' }));
    const b = within(screen.getByRole('article', { name: 'UP 456' }));
    await user.clear(a.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(a.getByRole('textbox', { name: '近期 N 条' }), '101');
    await user.clear(b.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(b.getByRole('textbox', { name: '近期 N 条' }), '27');
    await user.click(a.getByRole('button', { name: '保存配置' }));
    expect(a.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    fireEvent.submit(a.getByRole('textbox', { name: '近期 N 条' }).closest('form')!);
    expect(firstSaves).toBe(1);
    await user.selectOptions(b.getByRole('combobox', { name: '监控模式' }), 'specified');
    expect(b.getByText('保存指定模式后仅监控下方关联目标；不附加近期动态。')).toBeInTheDocument();
    expect(await b.findByRole('textbox', { name: '动态 ID' })).toBeInTheDocument();
    b.getByRole('button', { name: '保存配置' }).focus();
    await user.keyboard('{Enter}');
    expect(await b.findByText('保存成功。')).toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 })));
    expect(await a.findByRole('alert')).toHaveTextContent('配置存储暂不可用');
    expect(a.queryByText('保存成功。')).not.toBeInTheDocument();
    expect(a.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('101');
    expect(b.getByRole('combobox', { name: '监控模式' })).toHaveValue('specified');
    await user.click(a.getByRole('button', { name: '重试保存' }));
    expect(await a.findByText('保存成功。')).toBeInTheDocument();
    expect(writes).toEqual([
      { url: '/api/manage/ups/123/monitor', body: { mode: 'recent', recent_n: 101, enabled: true } },
      { url: '/api/manage/ups/456/monitor', body: { mode: 'specified', recent_n: 27, enabled: true } },
      { url: '/api/manage/ups/123/monitor', body: { mode: 'recent', recent_n: 101, enabled: true } },
    ]);
  });
  it('只输入字符串 UID 新增：阻塞时防重，资料失败保留输入并原位重试，昵称头像兜底', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const uid = '900719925474099312345';
    let posts = 0;
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [] });
      expect(init.body).toBe('{"uid":"900719925474099312345"}');
      posts++;
      return posts === 1 ? pending.promise : Response.json({ ...up(uid), name: '', avatar_url: '' }, { status: 201 });
    });
    const input = await screen.findByRole('textbox', { name: 'UP UID' });
    await user.type(input, uid);
    const add = screen.getByRole('button', { name: '添加监控' });
    await user.click(add);
    expect(add).toBeDisabled();
    fireEvent.submit(input.closest('form')!);
    expect(posts).toBe(1);
    await act(async () => pending.resolve(Response.json({ error: { code: 'PROFILE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 502 })));
    expect(await screen.findByRole('alert')).toHaveTextContent('未取得 UP 资料');
    expect(input).toHaveValue(uid);
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    expect(screen.queryByText('添加成功。')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试添加' }));
    const card = await screen.findByRole('article', { name: `UP ${uid}` });
    expect(within(card).getByText('未知用户')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: '未知用户的头像' })).toHaveAttribute('src', '/default-avatar.svg');
    expect(within(card).getByText('最近检查：未检查')).toBeInTheDocument();
    expect(within(card).getByText('最近成功：未检查')).toBeInTheDocument();
    expect(within(input.closest('form')!).getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByLabelText(/昵称|头像|凭据/)).not.toBeInTheDocument();
  });
  it('默认同源 fetch：加载、读取失败固定提示、原位键盘重试和空态，显著说明公网风险', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const http = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ ups: [] }));
    show();
    expect(screen.getByText('正在读取管理配置…')).toBeInTheDocument();
    expect(screen.getByText(/首期无鉴权/)).toBeInTheDocument();
    expect(screen.getByText(/公网管理页和 API/)).toHaveTextContent(/公网.*第三方.*读取.*修改/);
    await act(async () => pending.resolve(Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 })));
    expect(await screen.findByRole('alert')).toHaveTextContent('配置存储暂不可用，请重试。');
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    const retry = screen.getByRole('button', { name: '重新读取' });
    retry.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('尚未保存 UP，请输入 UID 添加。')).toBeInTheDocument();
    expect(http).toHaveBeenCalledTimes(2);
  });
});
