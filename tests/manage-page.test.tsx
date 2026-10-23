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
function show(transport?: ManagementTransport, path = '/manage') {
  return render(<MemoryRouter initialEntries={[path]}><Visits />
    <App reader={reader} {...(transport ? { manageApi: createManagementApi(transport) } : {})} />
  </MemoryRouter>);
}
/** 从列表页点进单 UP 管理页；返回该 UP 卡片的查询作用域。 */
async function openUp(uid: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('link', { name: `管理 UP ${uid}` }));
  return within(await screen.findByRole('article', { name: `UP ${uid}` }));
}

describe('/manage UP 列表页', () => {
  it('列表只展示身份与监控状态，不读取检查或发现，点卡片进入单 UP 管理页', async () => {
    const requests: string[] = [];
    show(async (url, init) => {
      requests.push(url);
      expect(init.method).toBe('GET');
      return Response.json({ ups: [up('123'), { ...up('456'), monitor: { ...up('456').monitor, enabled: false } },
        { ...up('789'), monitor: null }] });
    });
    const list = await screen.findByRole('list', { name: 'UP 列表' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual([
      '用户 123UID：123监控已启用', '用户 456UID：456监控已停止', '用户 789UID：789配置已删除',
    ]);
    expect(requests).toEqual(['/api/manage/ups']);
    const card = await openUp('123');
    expect(card.getByText('用户 123')).toBeInTheDocument();
    await screen.findByRole('button', { name: '读取检查状态' });
  });
  it('UID 校验失败不发请求：空白、前导零、科学计数与超长都保留输入', async () => {
    const user = userEvent.setup();
    let mutations = 0;
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [] });
      mutations++;
      return Response.json(up('123'), { status: 201 });
    });
    const uidInput = await screen.findByRole('textbox', { name: 'UP UID' });
    for (const uid of [' 123', '0123', '1e3', '9'.repeat(129)]) {
      await user.clear(uidInput); await user.type(uidInput, uid);
      await user.click(screen.getByRole('button', { name: '添加监控' }));
      expect(screen.getByRole('alert')).toHaveTextContent('UID 须为');
      expect(uidInput).toHaveValue(uid);
    }
    await user.clear(uidInput);
    await user.click(screen.getByRole('button', { name: '添加监控' }));
    expect(screen.getByRole('alert')).toHaveTextContent('UID 须为');
    expect(mutations).toBe(0);
  });
  it('忽略取消的旧读取不覆盖新管理访问的身份集合', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    let reads = 0;
    show(async () => ++reads === 1 ? pending.promise : Response.json({ ups: [up('456')] }));
    await user.click(screen.getByRole('button', { name: '新管理访问' }));
    expect(await screen.findByRole('link', { name: '管理 UP 456' })).toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({ ups: [up('123')] })));
    expect(screen.queryByRole('link', { name: '管理 UP 123' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '管理 UP 456' })).toBeInTheDocument();
  });
  it('坏 JSON 读取可原位重试，恶意昵称只作文字', async () => {
    const user = userEvent.setup();
    let reads = 0;
    show(async () => ++reads === 1 ? new Response('SECRET_TOKEN')
      : Response.json({ ups: [up('123', '<img src=x onerror=alert(1)>'), up('456')] }));
    expect(await screen.findByRole('alert')).toHaveTextContent('管理接口响应异常');
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    const link = await screen.findByRole('link', { name: '管理 UP 123' });
    expect(within(link).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
  it('只输入字符串 UID 新增：阻塞时防重，资料失败保留输入并原位重试，昵称头像兜底', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const uid = '900719925474099312345';
    let posts = 0;
    let stored: unknown[] = [];
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: stored });
      expect(init.body).toBe('{"uid":"900719925474099312345"}');
      posts++;
      if (posts === 1) return pending.promise;
      stored = [{ ...up(uid), name: '', avatar_url: '' }];
      return Response.json(stored[0], { status: 201 });
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
    const link = await screen.findByRole('link', { name: `管理 UP ${uid}` });
    expect(within(link).getByText('未知用户')).toBeInTheDocument();
    expect(screen.getByText('添加成功。')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(within(input.closest('form')!).getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByLabelText(/昵称|头像|凭据/)).not.toBeInTheDocument();
    const card = await openUp(uid);
    expect(card.getByRole('img', { name: '未知用户的头像' })).toHaveAttribute('src', '/default-avatar.svg');
    expect(card.getByText('最近检查：未检查')).toBeInTheDocument();
    expect(card.getByText('最近成功：尚未成功')).toBeInTheDocument();
  });
  it('默认同源 fetch：加载、读取失败固定提示、原位键盘重试和空态', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const http = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ ups: [] }));
    show();
    expect(screen.getByText('正在读取管理配置…')).toBeInTheDocument();
    await act(async () => pending.resolve(Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 })));
    expect(await screen.findByRole('alert')).toHaveTextContent('配置存储暂不可用，请重试。');
    expect(document.body).not.toHaveTextContent('SECRET_TOKEN');
    const retry = screen.getByRole('button', { name: '重新读取' });
    retry.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('尚未保存 UP，请输入 UID 添加。')).toBeInTheDocument();
    expect(http).toHaveBeenCalledTimes(2);
  });
  it('单 UP 路径下 UP 不存在时提示并回到列表，不做配置草稿', async () => {
    show(async () => Response.json({ ups: [up('456')] }), '/manage/ups/123');
    expect(await screen.findByText('未找到该 UP，可能已被删除。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回 UP 列表' })).toHaveAttribute('href', '/manage');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});

describe('/manage/ups/:uid 单 UP 管理页', () => {
  it('近期 N 校验失败不发请求；非法成功 JSON 保留草稿而非显示保存成功', async () => {
    const user = userEvent.setup();
    let mutations = 0;
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [up('123')] });
      mutations++;
      return Response.json({ ...up('123'), monitor: { mode: 'recent', recent_n: '21', enabled: true } });
    }, '/manage/ups/123');
    const a = within(await screen.findByRole('article', { name: 'UP 123' }));
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
  it.each(['success', 'error'] as const)('取消的旧保存 %s 不污染重新进入的访问或另一 UP', async kind => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    let oldSignal: AbortSignal | null | undefined;
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [up('123'), up('456')] });
      oldSignal = init.signal;
      return pending.promise;
    }, '/manage/ups/123');
    let a = within(await screen.findByRole('article', { name: 'UP 123' }));
    await user.clear(a.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(a.getByRole('textbox', { name: '近期 N 条' }), '21');
    await user.click(a.getByRole('button', { name: '保存配置' }));
    await user.click(screen.getByRole('button', { name: '离开管理' }));
    expect(oldSignal?.aborted).toBe(true);
    await user.click(screen.getByRole('button', { name: '新管理访问' }));
    a = await openUp('123');
    expect(a.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');
    expect(a.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'UP 列表' }));
    await user.click(await screen.findByRole('link', { name: '管理 UP 456' }));
    await act(async () => pending.resolve(kind === 'success'
      ? Response.json({ ...up('123'), monitor: { ...up('123').monitor, recent_n: 21 } })
      : Response.json({ error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } }, { status: 500 })));
    const b = within(screen.getByRole('article', { name: 'UP 456' }));
    expect(b.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');
    expect(screen.queryByText('保存成功。')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('离开再进入不保留上一访问的草稿与提示，切换 UP 只显示该 UP 的已保存配置', async () => {
    const user = userEvent.setup();
    show(async (_url, init) => {
      expect(init.method).toBe('GET');
      return Response.json({ ups: [up('123'), { ...up('456'), monitor: { ...up('456').monitor, mode: 'specified' } }] });
    }, '/manage/ups/123');
    let a = within(await screen.findByRole('article', { name: 'UP 123' }));
    await user.clear(a.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(a.getByRole('textbox', { name: '近期 N 条' }), '37');
    await user.click(screen.getByRole('link', { name: 'UP 列表' }));
    await user.click(await screen.findByRole('link', { name: '管理 UP 456' }));
    const b = within(await screen.findByRole('article', { name: 'UP 456' }));
    expect(b.getByRole('combobox', { name: '监控模式' })).toHaveValue('specified');
    await user.click(screen.getByRole('link', { name: 'UP 列表' }));
    await user.click(await screen.findByRole('link', { name: '管理 UP 123' }));
    a = within(await screen.findByRole('article', { name: 'UP 123' }));
    expect(a.getByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');
    expect(a.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('删除失败保留草稿，删除仅配置后身份保留并可重新添加', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    let deletes = 0; let adds = 0;
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [up('123')] });
      if (init.method === 'DELETE') {
        deletes++;
        return deletes === 1 ? Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 })
          : new Response(null, { status: 204 });
      }
      adds++;
      return adds === 1 ? pending.promise : Response.json(up('123'), { status: 201 });
    }, '/manage/ups/123');
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
    await user.click(a.getByRole('button', { name: '重新添加监控' }));
    expect(a.getByRole('button', { name: '正在重新添加…' })).toBeDisabled();
    await act(async () => pending.resolve(Response.json({ error: { code: 'PROFILE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 502 })));
    expect(await a.findByRole('alert')).toHaveTextContent('未取得 UP 资料');
    expect(a.getByText('用户 123')).toBeInTheDocument();
    await user.click(a.getByRole('button', { name: '重试重新添加' }));
    a = within(screen.getByRole('article', { name: 'UP 123' }));
    expect(await a.findByRole('textbox', { name: '近期 N 条' })).toHaveValue('10');
    expect(adds).toBe(2);
  });
  it('启停只使用该 UP 已保存配置，失败原位重试，既不提交也不丢失未保存草稿', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const bodies: unknown[] = [];
    show(async (_url, init) => {
      if (init.method === 'GET') return Response.json({ ups: [up('123')] });
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return pending.promise;
      return Response.json({ ...up('123'), monitor: { ...up('123').monitor,
        recent_n: bodies.length === 2 ? 10 : 31, enabled: false } });
    }, '/manage/ups/123');
    const a = within(await screen.findByRole('article', { name: 'UP 123' }));
    const n = a.getByRole('textbox', { name: '近期 N 条' });
    await user.clear(n); await user.type(n, '31');
    await user.click(a.getByRole('button', { name: '停止监控' }));
    expect(a.getByRole('button', { name: '正在停止…' })).toBeDisabled();
    expect(a.getByRole('button', { name: '保存配置' })).toBeDisabled();
    await act(async () => pending.resolve(Response.json({ error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } }, { status: 500 })));
    expect(await a.findByRole('alert')).toHaveTextContent('管理服务暂不可用');
    expect(a.getByText('监控：已启用')).toBeInTheDocument();
    expect(n).toHaveValue('31');
    await user.click(a.getByRole('button', { name: '重试停止' }));
    expect(await a.findByText('监控：已停止')).toBeInTheDocument();
    expect(n).toHaveValue('31');
    await user.click(a.getByRole('button', { name: '保存配置' }));
    expect(await a.findByText('保存成功。')).toBeInTheDocument();
    expect(bodies).toEqual([
      { mode: 'recent', recent_n: 10, enabled: false },
      { mode: 'recent', recent_n: 10, enabled: false },
      { mode: 'recent', recent_n: 31, enabled: false },
    ]);
  });
  it('互斥模式可键盘保存；保存失败原位重试后才显示成功', async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const writes: { url: string; body: unknown }[] = [];
    show(async (url, init) => {
      if (url.endsWith('/targets') && init.method === 'GET') return Response.json({ targets: [] });
      if (init.method === 'GET') return Response.json({ ups: [up('123')] });
      writes.push({ url, body: JSON.parse(String(init.body)) });
      if (writes.length === 1) return pending.promise;
      return Response.json({ ...up('123'), monitor: { ...up('123').monitor, mode: 'specified', recent_n: 27 } });
    }, '/manage/ups/123');
    const a = within(await screen.findByRole('article', { name: 'UP 123' }));
    await user.clear(a.getByRole('textbox', { name: '近期 N 条' }));
    await user.type(a.getByRole('textbox', { name: '近期 N 条' }), '27');
    await user.selectOptions(a.getByRole('combobox', { name: '监控模式' }), 'specified');
    expect(a.getByText('保存指定模式后仅监控下方关联目标；不附加近期动态。')).toBeInTheDocument();
    expect(await a.findByRole('textbox', { name: '动态 ID' })).toBeInTheDocument();
    a.getByRole('button', { name: '保存配置' }).focus();
    await user.keyboard('{Enter}');
    expect(a.getByRole('button', { name: '正在保存…' })).toBeDisabled();
    await act(async () => pending.resolve(Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 })));
    expect(await a.findByRole('alert')).toHaveTextContent('配置存储暂不可用');
    expect(a.queryByText('保存成功。')).not.toBeInTheDocument();
    expect(a.getByRole('combobox', { name: '监控模式' })).toHaveValue('specified');
    await user.click(a.getByRole('button', { name: '重试保存' }));
    expect(await a.findByText('保存成功。')).toBeInTheDocument();
    expect(writes).toEqual([
      { url: '/api/manage/ups/123/monitor', body: { mode: 'specified', recent_n: 27, enabled: true } },
      { url: '/api/manage/ups/123/monitor', body: { mode: 'specified', recent_n: 27, enabled: true } },
    ]);
  });
});
