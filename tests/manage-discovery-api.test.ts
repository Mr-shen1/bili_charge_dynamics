import { expect, it } from 'vitest';
import { createManagementApi } from '../src/manage/managementApi';

const signal = new AbortController().signal;
const discovery = {
  uid: '123', mode: 'recent', recent_n: 3, enabled: true, active: true,
  status: 'failed', retryable: true, incomplete: true,
  attempt: { recent_n: 3, started_at: '2025-06-01T02:00:00Z', finished_at: '2025-06-01T02:01:00Z',
    ids: ['3'], error: 'PAGINATION_INVALID' },
  trusted_result: { recent_n: 2, ids: ['900719925474099312345', '2'], exhausted: false,
    discovered_at: '2025-05-31T02:00:00Z' },
  current_ids: ['900719925474099312345', '2'],
};

it('只读发现映射独立保留本轮部分候选、旧可信结果和当前窗口，不泄漏额外 HTTP 原文', async () => {
  const api = createManagementApi(async (url, init) => {
    expect(url).toBe('/api/manage/ups/123/discovery');
    expect(init).toEqual({ method: 'GET', signal });
    return Response.json({ ...discovery, message: 'SECRET_TOKEN' });
  });
  expect(await api.getDiscovery({ uid: '123', signal })).toEqual({ status: 'success', data: {
    uid: '123', mode: 'recent', recentN: 3, enabled: true, active: true,
    status: 'failed', retryable: true, incomplete: true,
    attempt: { recentN: 3, startedAt: '2025-06-01T02:00:00Z', finishedAt: '2025-06-01T02:01:00Z',
      ids: ['3'], error: 'PAGINATION_INVALID' },
    trustedResult: { recentN: 2, ids: ['900719925474099312345', '2'], exhausted: false,
      discoveredAt: '2025-05-31T02:00:00Z' },
    currentIds: ['900719925474099312345', '2'],
  } });
});

it('拒绝矛盾配置/本轮状态及任何结构、ID、枚举、时间错误，不伪造可信窗口', async () => {
  const invalid: unknown[] = [
    { ...discovery, enabled: false, active: false },
    { ...discovery, mode: 'specified', active: false },
    { ...discovery, mode: null, recent_n: null, enabled: false, active: false },
    { ...discovery, active: false },
    { ...discovery, mode: null },
    { ...discovery, recent_n: null },
    { ...discovery, status: 'undiscovered' },
    { ...discovery, status: 'running' },
    { ...discovery, status: 'discovered' },
    { ...discovery, attempt: null },
    { ...discovery, attempt: { ...discovery.attempt, finished_at: null } },
    { ...discovery, attempt: { ...discovery.attempt, error: null } },
    null, [], {}, { ...discovery, uid: '456' }, { ...discovery, uid: 123 },
    { ...discovery, uid: '0123' }, { ...discovery, uid: '1'.repeat(129) },
    { ...discovery, mode: 'all' }, { ...discovery, recent_n: 0 },
    { ...discovery, recent_n: 9007199254740992 }, { ...discovery, recent_n: '3' },
    { ...discovery, enabled: 1 }, { ...discovery, retryable: 'true' }, { ...discovery, incomplete: null },
    { ...discovery, status: 'success' }, { ...discovery, current_ids: undefined },
    { ...discovery, current_ids: [1] }, { ...discovery, current_ids: ['01'] },
    { ...discovery, current_ids: ['1', '1'] },
    { ...discovery, current_ids: ['2'] },
    { ...discovery, current_ids: ['2', '900719925474099312345'] },
    { ...discovery, trusted_result: null, current_ids: ['2'] },
    { ...discovery, attempt: [] }, { ...discovery, trusted_result: [] },
    ...['ids', 'recent_n', 'started_at', 'finished_at', 'error'].map(key => ({
      ...discovery, attempt: { ...discovery.attempt, [key]: undefined },
    })),
    ...['ids', 'recent_n', 'discovered_at', 'exhausted'].map(key => ({
      ...discovery, trusted_result: { ...discovery.trusted_result, [key]: undefined },
    })),
    { ...discovery, attempt: { ...discovery.attempt, ids: ['2', '2'] } },
    { ...discovery, trusted_result: { ...discovery.trusted_result, ids: ['0'] } },
    { ...discovery, attempt: { ...discovery.attempt, recent_n: true } },
    { ...discovery, trusted_result: { ...discovery.trusted_result, recent_n: 1.5 } },
    { ...discovery, attempt: { ...discovery.attempt, error: 'SECRET_TOKEN' } },
    { ...discovery, trusted_result: { ...discovery.trusted_result, exhausted: 1 } },
    ...['2025-02-30T00:00:00Z', '2025-06-01T02:00:00', 'SECRET_TOKEN', null].map(time => ({
      ...discovery, attempt: { ...discovery.attempt, started_at: time },
    })),
    { ...discovery, attempt: { ...discovery.attempt, finished_at: '2025-02-30T00:00:00Z' } },
    { ...discovery, trusted_result: { ...discovery.trusted_result, discovered_at: null } },
    { ...discovery, trusted_result: { ...discovery.trusted_result, discovered_at: '2025-06-01' } },
  ];
  for (const body of invalid) {
    const result = await createManagementApi(async () => Response.json(body)).getDiscovery({ uid: '123', signal });
    expect(result, JSON.stringify(body)).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
  }
});

it('矛盾的就绪/重试信号与不可能的完整结果不能制造窗口就绪', async () => {
  const invalid = [
    { ...discovery, incomplete: false },
    { ...discovery, retryable: false },
    { ...discovery, status: 'running', attempt: { ...discovery.attempt, finished_at: null, error: null } },
    { ...discovery, status: 'undiscovered', attempt: null, trusted_result: null, incomplete: false },
    { ...discovery, status: 'discovered', attempt: { ...discovery.attempt, error: null }, incomplete: false },
    { ...discovery, trusted_result: { ...discovery.trusted_result, ids: [], exhausted: false } },
    { ...discovery, trusted_result: { ...discovery.trusted_result, recent_n: 1 } },
    { ...discovery, attempt: { ...discovery.attempt, recent_n: 1, ids: ['3', '4'] } },
  ];
  for (const body of invalid) {
    expect(await createManagementApi(async () => Response.json(body)).getDiscovery({ uid: '123', signal }))
      .toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
  }
});

it('发现读取对 HTTP/JSON/网络失败仅返回固定安全文案，不回显原文或异常', async () => {
  const failures = [
    { response: Response.json({ error: { code: 'NOT_FOUND', message: 'SECRET_TOKEN' } }, { status: 404 }), message: '身份或监控配置不存在，请重新读取。' },
    { response: Response.json({ error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 }), message: '配置存储暂不可用，请重试。' },
    { response: Response.json({ error: { code: 'INTERNAL_ERROR', message: 'SECRET_TOKEN' } }, { status: 500 }), message: '管理服务暂不可用，请重试。' },
    { response: Response.json({ error: { code: 'INVALID_INPUT', message: 'SECRET_TOKEN' } }, { status: 422 }), message: '输入不合法，请检查后重试。' },
    { response: Response.json({ error: { code: 'SECRET_TOKEN', message: 'SECRET_TOKEN' } }, { status: 500 }), message: '管理接口响应异常，请重试。' },
    { response: Response.json({ error: { code: 'NOT_FOUND', message: 'SECRET_TOKEN' } }, { status: 500 }), message: '管理接口响应异常，请重试。' },
    { response: new Response('SECRET_TOKEN', { status: 502 }), message: '管理接口响应异常，请重试。' },
    { response: new Response('SECRET_TOKEN'), message: '管理接口响应异常，请重试。' },
    { response: Response.json(discovery, { status: 201 }), message: '管理接口响应异常，请重试。' },
    { response: new Response(null, { status: 204 }), message: '管理接口响应异常，请重试。' },
  ];
  for (const { response, message } of failures) {
    expect(await createManagementApi(async () => response).getDiscovery({ uid: '123', signal }))
      .toEqual({ status: 'error', message });
  }
  expect(await createManagementApi(async () => { throw new Error('SECRET_TOKEN'); }).getDiscovery({ uid: '123', signal }))
    .toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
});

it('非法 UID 或预取消不发 HTTP，请求后的取消也压制忽略取消的迟到响应', async () => {
  let requests = 0;
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const api = createManagementApi(async () => { requests++; return pending; });
  for (const uid of ['0123', '0', ' 123', '1/targets', '1'.repeat(129)]) {
    expect(await api.getDiscovery({ uid, signal })).toMatchObject({ status: 'error', message: expect.stringContaining('UID 须为') });
  }
  const cancelled = new AbortController();
  cancelled.abort();
  expect(await api.getDiscovery({ uid: '123', signal: cancelled.signal })).toEqual({ status: 'cancelled' });
  expect(requests).toBe(0);
  const current = new AbortController();
  const result = api.getDiscovery({ uid: '123', signal: current.signal });
  current.abort();
  finish(Response.json(discovery));
  expect(await result).toEqual({ status: 'cancelled' });
  expect(requests).toBe(1);
});
