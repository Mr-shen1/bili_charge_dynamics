import { describe, expect, it, vi } from 'vitest';
import {
  authenticationRequiredMessage, createManagementApi, invalidTargetMessage, invalidUidMessage,
  type ManagementTransport,
} from '../../src/manage/managementApi';

// 生产 DTO 夹具：字段与 docs/backend/api/management-api.md 的 UP 结构一致。
const uid = '900719925474099312345';
const invalidResponseMessage = '管理接口响应异常，请重试。';

function managedUp(overrides: Record<string, unknown> = {}) {
  return {
    uid,
    name: '虚构星海',
    avatar_url: 'https://example.invalid/star.png',
    monitor: {
      mode: 'recent', recent_n: 10, enabled: false,
      last_checked_at: null, last_succeeded_at: null,
    },
    ...overrides,
  };
}

function transportOf(...responses: (Response | Promise<Response>)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport: ManagementTransport = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    return next;
  };
  return { transport, calls };
}

function signal() {
  return new AbortController().signal;
}

describe('管理接口映射', () => {
  it('列表按后端顺序映射身份与监控状态，删除配置的身份保留 monitor=null', async () => {
    const { transport, calls } = transportOf(Response.json({ ups: [
      managedUp(),
      managedUp({ uid: '456', name: '虚构晨光', avatar_url: null, monitor: { ...managedUp().monitor, enabled: true } }),
      managedUp({ uid: '789', monitor: null }),
    ] }));
    const result = await createManagementApi(transport).listUps({ signal: signal() });
    expect(result).toEqual({ status: 'success', data: [
      { uid, name: '虚构星海', avatarUrl: 'https://example.invalid/star.png',
        monitor: { mode: 'recent', recentN: 10, enabled: false, lastCheckedAt: null, lastSucceededAt: null } },
      { uid: '456', name: '虚构晨光', avatarUrl: null,
        monitor: { mode: 'recent', recentN: 10, enabled: true, lastCheckedAt: null, lastSucceededAt: null } },
      { uid: '789', name: '虚构星海', avatarUrl: 'https://example.invalid/star.png', monitor: null },
    ] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/manage/ups');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('新增只提交字符串 UID，不转换数值精度', async () => {
    const { transport, calls } = transportOf(Response.json(managedUp(), { status: 201 }));
    const result = await createManagementApi(transport).addUp({ uid, signal: signal() });
    expect(result).toEqual({ status: 'success', data: {
      uid, name: '虚构星海', avatarUrl: 'https://example.invalid/star.png',
      monitor: { mode: 'recent', recentN: 10, enabled: false, lastCheckedAt: null, lastSucceededAt: null },
    } });
    expect(calls[0]!.url).toBe('/api/manage/ups');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBe('{"uid":"900719925474099312345"}');
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
  });

  it('启停提交完整已保存配置而不是草稿', async () => {
    const { transport, calls } = transportOf(Response.json(managedUp({
      monitor: { mode: 'specified', recent_n: 27, enabled: true, last_checked_at: null, last_succeeded_at: null },
    })));
    const result = await createManagementApi(transport).updateMonitor({
      uid, monitor: { mode: 'specified', recentN: 27, enabled: true }, signal: signal(),
    });
    expect(result.status).toBe('success');
    expect(calls[0]!.url).toBe(`/api/manage/ups/${uid}/monitor`);
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(calls[0]!.init.body).toBe('{"mode":"specified","recent_n":27,"enabled":true}');
  });
});

describe('管理接口的输入与响应守卫', () => {
  it('UID 与近期 N 在本地校验失败时不发请求', async () => {
    const { transport, calls } = transportOf();
    const api = createManagementApi(transport);
    for (const value of [' 123', '0123', '1e3', '0', '9'.repeat(129), '']) {
      expect(await api.addUp({ uid: value, signal: signal() }))
        .toEqual({ status: 'error', message: invalidUidMessage });
    }
    for (const recentN of [0, -1, 1.5, 9007199254740992, Number.NaN]) {
      expect(await api.updateMonitor({ uid, monitor: { mode: 'recent', recentN, enabled: true }, signal: signal() }))
        .toEqual({ status: 'error', message: '近期 N 须为正的安全整数，模式与启停须有效。' });
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['非 https 头像', managedUp({ avatar_url: 'http://example.invalid/star.png' })],
    ['带用户信息的头像地址', managedUp({ avatar_url: 'https://user:secret@example.invalid/star.png' })],
    ['前导零 UID', managedUp({ uid: '0123' })],
    ['昵称类型不符', managedUp({ name: 42 })],
    ['未知模式', managedUp({ monitor: { ...managedUp().monitor, mode: 'all' } })],
    ['近期 N 非安全整数', managedUp({ monitor: { ...managedUp().monitor, recent_n: 9007199254740992 } })],
    ['启停非布尔', managedUp({ monitor: { ...managedUp().monitor, enabled: 'true' } })],
    ['检查时间无时区', managedUp({ monitor: { ...managedUp().monitor, last_checked_at: '2026-03-01T10:03:04' } })],
  ])('%s 的响应整体判为无效', async (_label, body) => {
    const { transport } = transportOf(Response.json({ ups: [body] }));
    expect(await createManagementApi(transport).listUps({ signal: signal() }))
      .toEqual({ status: 'error', message: invalidResponseMessage });
  });

  it('重复 UID 的列表判为整体无效', async () => {
    const { transport } = transportOf(Response.json({ ups: [managedUp(), managedUp()] }));
    expect(await createManagementApi(transport).listUps({ signal: signal() }))
      .toEqual({ status: 'error', message: invalidResponseMessage });
  });

  it('新增成功的响应必须带监控配置且 UID 一致', async () => {
    for (const body of [managedUp({ monitor: null }), managedUp({ uid: '456' })]) {
      const { transport } = transportOf(Response.json(body, { status: 201 }));
      expect(await createManagementApi(transport).addUp({ uid, signal: signal() }))
        .toEqual({ status: 'error', message: invalidResponseMessage });
    }
    const { transport } = transportOf(Response.json(managedUp(), { status: 200 }));
    expect(await createManagementApi(transport).addUp({ uid, signal: signal() }))
      .toEqual({ status: 'error', message: invalidResponseMessage });
  });

  it('错误响应只按固定错误码与状态映射，不回显响应正文', async () => {
    const cases: [number, string, string][] = [
      [422, 'INVALID_INPUT', '输入不合法，请检查后重试。'],
      [409, 'ALREADY_MONITORED', '该 UID 已有监控配置。'],
      [502, 'PROFILE_UNAVAILABLE', '未取得 UP 资料，请重试。'],
      [503, 'STORAGE_UNAVAILABLE', '配置存储暂不可用，请重试。'],
      [500, 'INTERNAL_ERROR', '管理服务暂不可用，请重试。'],
    ];
    for (const [status, code, message] of cases) {
      const { transport } = transportOf(Response.json({ error: { code, message: 'SECRET_TOKEN' } }, { status }));
      const result = await createManagementApi(transport).addUp({ uid, signal: signal() });
      expect(result).toEqual({ status: 'error', message });
      expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    }
  });

  it('错误码与 HTTP 状态不符、未知错误码或非 JSON 正文一律给固定提示', async () => {
    for (const [status, body] of [
      [409, { error: { code: 'INVALID_INPUT', message: 'SECRET_TOKEN' } }],
      [500, { error: { code: 'SOMETHING_NEW', message: 'SECRET_TOKEN' } }],
      [500, { error: 'SECRET_TOKEN' }],
      [500, {}],
    ] as const) {
      const { transport } = transportOf(Response.json(body, { status }));
      expect(await createManagementApi(transport).addUp({ uid, signal: signal() }))
        .toEqual({ status: 'error', message: invalidResponseMessage });
    }
    const { transport } = transportOf(new Response('SECRET_TOKEN', { status: 500 }));
    const result = await createManagementApi(transport).addUp({ uid, signal: signal() });
    expect(result).toEqual({ status: 'error', message: invalidResponseMessage });
    expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
  });
});

describe('指定目标与删除监控配置', () => {
  it('目标列表映射字符串 ID，并校验重复与非法 ID', async () => {
    const { transport, calls } = transportOf(Response.json({ targets: [{ id: '9007199254740993123' }] }));
    expect(await createManagementApi(transport).listTargets({ uid, signal: signal() }))
      .toEqual({ status: 'success', data: [{ id: '9007199254740993123' }] });
    expect(calls[0]!.url).toBe(`/api/manage/ups/${uid}/targets`);
    expect(calls[0]!.init.method).toBe('GET');

    for (const body of [[{ id: '0123' }], [{ id: '123' }, { id: '123' }], [{ id: 123 }], [{ id: '' }]]) {
      const invalid = transportOf(Response.json({ targets: body }));
      expect(await createManagementApi(invalid.transport).listTargets({ uid, signal: signal() }))
        .toEqual({ status: 'error', message: invalidResponseMessage });
    }
  });

  it('添加目标只提交字符串 ID，作者不符与无法确认分别给固定提示', async () => {
    const added = transportOf(Response.json({ id: '9007199254740993123' }, { status: 201 }));
    expect(await createManagementApi(added.transport).addTarget({ uid, id: '9007199254740993123', signal: signal() }))
      .toEqual({ status: 'success', data: { id: '9007199254740993123' } });
    expect(added.calls[0]!.url).toBe(`/api/manage/ups/${uid}/targets`);
    expect(added.calls[0]!.init.method).toBe('POST');
    expect(added.calls[0]!.init.body).toBe('{"id":"9007199254740993123"}');

    const cases: [number, string, string][] = [
      [409, 'TARGET_AUTHOR_MISMATCH', '动态作者与所选 UP 不符。'],
      [502, 'TARGET_UNVERIFIED', '无法确认动态归属。'],
    ];
    for (const [status, code, message] of cases) {
      const { transport } = transportOf(
        Response.json({ error: { code, message: 'SECRET_TOKEN' } }, { status }));
      const result = await createManagementApi(transport).addTarget({ uid, id: '123', signal: signal() });
      expect(result).toEqual({ status: 'error', message });
      expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    }

    for (const body of [{ id: '456' }, { id: 123 }, { target: '123' }]) {
      const invalid = transportOf(Response.json(body, { status: 201 }));
      expect(await createManagementApi(invalid.transport).addTarget({ uid, id: '123', signal: signal() }))
        .toEqual({ status: 'error', message: invalidResponseMessage });
    }
  });

  it('非 GET 目标请求在本地校验 ID 与 UID，不发送请求', async () => {
    const { transport, calls } = transportOf();
    const api = createManagementApi(transport);
    for (const id of ['', '0123', ' 123', '1e3', '9'.repeat(129)]) {
      expect(await api.addTarget({ uid, id, signal: signal() }))
        .toEqual({ status: 'error', message: invalidTargetMessage });
      expect(await api.deleteTarget({ uid, id, signal: signal() }))
        .toEqual({ status: 'error', message: invalidTargetMessage });
    }
    expect(await api.listTargets({ uid: '0123', signal: signal() }))
      .toEqual({ status: 'error', message: invalidUidMessage });
    expect(calls).toHaveLength(0);
  });

  it('移除目标只解除关联：204 成功，其他状态按固定码映射', async () => {
    const removed = transportOf(new Response(null, { status: 204 }));
    expect(await createManagementApi(removed.transport).deleteTarget({ uid, id: '123', signal: signal() }))
      .toEqual({ status: 'success', data: undefined });
    expect(removed.calls[0]!.url).toBe(`/api/manage/ups/${uid}/targets/123`);
    expect(removed.calls[0]!.init.method).toBe('DELETE');

    const { transport } = transportOf(
      Response.json({ error: { code: 'NOT_FOUND', message: 'SECRET_TOKEN' } }, { status: 404 }));
    expect(await createManagementApi(transport).deleteTarget({ uid, id: '123', signal: signal() }))
      .toEqual({ status: 'error', message: '身份或监控配置不存在，请重新读取。' });

    const accepted = transportOf(Response.json({ id: '123' }));
    expect(await createManagementApi(accepted.transport).deleteTarget({ uid, id: '123', signal: signal() }))
      .toEqual({ status: 'error', message: invalidResponseMessage });
  });

  it('删除配置只发 DELETE，返回 204 才算成功', async () => {
    const removed = transportOf(new Response(null, { status: 204 }));
    expect(await createManagementApi(removed.transport).deleteMonitor({ uid, signal: signal() }))
      .toEqual({ status: 'success', data: undefined });
    expect(removed.calls[0]!.url).toBe(`/api/manage/ups/${uid}/monitor`);
    expect(removed.calls[0]!.init.method).toBe('DELETE');

    const { transport } = transportOf(
      Response.json({ error: { code: 'NOT_FOUND', message: 'SECRET_TOKEN' } }, { status: 404 }));
    expect(await createManagementApi(transport).deleteMonitor({ uid, signal: signal() }))
      .toEqual({ status: 'error', message: '身份或监控配置不存在，请重新读取。' });

    const noContent = transportOf(Response.json({}, { status: 200 }));
    expect(await createManagementApi(noContent.transport).deleteMonitor({ uid, signal: signal() }))
      .toEqual({ status: 'error', message: invalidResponseMessage });

    const { transport: unused, calls } = transportOf();
    expect(await createManagementApi(unused).deleteMonitor({ uid: '0123', signal: signal() }))
      .toEqual({ status: 'error', message: invalidUidMessage });
    expect(calls).toHaveLength(0);
  });
});

describe('管理接口的部署入口认证', () => {
  const targetPath = `/api/manage/ups/${uid}/targets`;
  const operations = [
    { name: 'listUps', path: '/api/manage/ups', method: 'GET',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) => api.listUps({ signal }) },
    { name: 'addUp', path: '/api/manage/ups', method: 'POST',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) => api.addUp({ uid, signal }) },
    { name: 'updateMonitor', path: `/api/manage/ups/${uid}/monitor`, method: 'PATCH',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.updateMonitor({ uid, monitor: { mode: 'recent', recentN: 10, enabled: true }, signal }) },
    { name: 'deleteMonitor', path: `/api/manage/ups/${uid}/monitor`, method: 'DELETE',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.deleteMonitor({ uid, signal }) },
    { name: 'listTargets', path: targetPath, method: 'GET',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.listTargets({ uid, signal }) },
    { name: 'addTarget', path: targetPath, method: 'POST',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.addTarget({ uid, id: '123', signal }) },
    { name: 'deleteTarget', path: `${targetPath}/123`, method: 'DELETE',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.deleteTarget({ uid, id: '123', signal }) },
  ];

  it('固定安全文案不指向页面入口', () => {
    expect(authenticationRequiredMessage).toBe('管理访问需要身份验证，请刷新页面重新认证。');
    expect(operations.map(operation => operation.name).sort())
      .toEqual(Object.keys(createManagementApi()).sort());
  });

  it.each(operations)('$name 在解析 JSON 前处理 HTML 401，不回显正文也不重试', async ({ run, path, method }) => {
    const html = '<html><h1>Unauthorized</h1><p>PRIVATE_PROXY_DETAIL</p></html>';
    const response = new Response(html, { status: 401, headers: { 'Content-Type': 'text/html' } });
    const json = vi.spyOn(response, 'json');
    const text = vi.spyOn(response, 'text');
    const fetch = vi.fn<ManagementTransport>().mockResolvedValue(response);
    const result = await run(createManagementApi(fetch), signal());
    expect(result).toEqual({ status: 'error', message: authenticationRequiredMessage });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_PROXY_DETAIL|Unauthorized/);
    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({ method }));
    expect(new Headers(fetch.mock.calls[0]![1].headers).has('Authorization')).toBe(false);
  });

  it.each(operations)('$name 已取消时不发送请求；传输忽略取消时取消优先', async ({ run }) => {
    const fetch = vi.fn<ManagementTransport>().mockResolvedValue(Response.json(managedUp()));
    const aborted = new AbortController();
    aborted.abort();
    expect(await run(createManagementApi(fetch), aborted.signal)).toEqual({ status: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    const response = Response.json(managedUp(), { status: 201 });
    const json = vi.spyOn(response, 'json');
    const ignoring: ManagementTransport = async () => {
      controller.abort();
      return response;
    };
    expect(await run(createManagementApi(ignoring), controller.signal)).toEqual({ status: 'cancelled' });
    expect(json).not.toHaveBeenCalled();
  });

  it.each(operations)('$name 传输异常给出固定提示，取消时不报告错误', async ({ run }) => {
    const failing = vi.fn<ManagementTransport>().mockRejectedValue(new Error('PRIVATE_PROXY_DETAIL'));
    const result = await run(createManagementApi(failing), signal());
    expect(result).toEqual({ status: 'error', message: invalidResponseMessage });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROXY_DETAIL');

    const controller = new AbortController();
    const aborting: ManagementTransport = async () => {
      controller.abort();
      throw new Error('PRIVATE_PROXY_DETAIL');
    };
    expect(await run(createManagementApi(aborting), controller.signal)).toEqual({ status: 'cancelled' });
  });
});
