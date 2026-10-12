import { describe, expect, it } from 'vitest';
import { createManagementApi, type ManagementTransport } from '../src/manage/managementApi';

const identity = {
  uid: '900719925474099312345', name: '测试 UP', avatar_url: 'https://example.test/avatar.png',
  monitor: { mode: 'recent', recent_n: 10, enabled: true, last_checked_at: null, last_succeeded_at: null },
};
const signal = new AbortController().signal;

describe('生产管理 HTTP 映射', () => {
  it('读取缺失身份资料与最大安全 N；取消优先于忽略 signal 的 HTTP 成功或错误', async () => {
    const api = createManagementApi(async () => Response.json({ ups: [{ ...identity, name: null, avatar_url: null,
      monitor: { ...identity.monitor, recent_n: 9007199254740991 } }] }));
    expect(await api.listUps({ signal })).toMatchObject({ status: 'success', data: [{ name: null, avatarUrl: null, monitor: { recentN: 9007199254740991 } }] });
    for (const response of [Response.json({ ups: [identity] }), new Response('SECRET_TOKEN', { status: 500 })]) {
      const controller = new AbortController();
      const cancelled = createManagementApi(async () => { controller.abort(); return response; });
      expect(await cancelled.listUps({ signal: controller.signal })).toEqual({ status: 'cancelled' });
    }
    let requests = 0;
    const cancelled = createManagementApi(async () => { requests++; return Response.json({ ups: [] }); });
    const controller = new AbortController(); controller.abort();
    expect(await cancelled.listUps({ signal: controller.signal })).toEqual({ status: 'cancelled' });
    expect(requests).toBe(0);
  });
  it('非法配置在传输前拒绝，PATCH 的非法成功响应与 DELETE 非 204 不冒充成功', async () => {
    let requests = 0;
    const api = createManagementApi(async () => { requests++; return Response.json(identity); });
    for (const recentN of [0, -1, 1.5, NaN, Infinity, 9007199254740992]) {
      expect(await api.updateMonitor({ uid: identity.uid, monitor: { mode: 'recent', recentN, enabled: true }, signal })).toMatchObject({ status: 'error' });
    }
    expect(requests).toBe(0);
    for (const body of [null, { ...identity, uid: '999' }, { ...identity, monitor: null }]) {
      const malformed = createManagementApi(async () => Response.json(body));
      expect(await malformed.updateMonitor({ uid: identity.uid, monitor: { mode: 'recent', recentN: 10, enabled: true }, signal })).toMatchObject({ status: 'error' });
    }
    expect(await api.deleteMonitor({ uid: identity.uid, signal })).toMatchObject({ status: 'error' });
  });
  it('拒绝成功状态中的非法结构、重复身份和不安全头像，不把坏数据当成功', async () => {
    const malformed: unknown[] = [null, {}, { ups: null }, { ups: [identity, identity] },
      ...[
        { uid: 123 }, { uid: '01' }, { name: 1 }, { avatar_url: 'javascript:SECRET_TOKEN' },
        { avatar_url: 'https://user:SECRET_TOKEN@example.test/avatar' }, { monitor: undefined },
        { monitor: { ...identity.monitor, recent_n: 9007199254740992 } },
        { monitor: { ...identity.monitor, enabled: 'true' } },
        { monitor: { ...identity.monitor, mode: 'both' } },
        { monitor: { ...identity.monitor, last_checked_at: 'SECRET_TOKEN' } },
      ].map(overrides => ({ ups: [{ ...identity, ...overrides }] })),
    ];
    for (const body of malformed) {
      expect(await createManagementApi(async () => Response.json(body)).listUps({ signal })).toMatchObject({ status: 'error' });
    }
    const wrongUp = createManagementApi(async () => Response.json({ ...identity, uid: '999' }, { status: 201 }));
    expect(await wrongUp.addUp({ uid: identity.uid, signal })).toMatchObject({ status: 'error' });
  });
  it('完整保存单 UP 配置，删除仅配置后仍能通过 UID 读取身份', async () => {
    let deleted = false;
    const api = createManagementApi(async (url, init) => {
      if (init.method === 'PATCH') {
        expect(url).toBe(`/api/manage/ups/${identity.uid}/monitor`);
        expect(init.body).toBe('{"mode":"specified","recent_n":101,"enabled":false}');
        return Response.json({ ...identity, monitor: { ...identity.monitor, mode: 'specified', recent_n: 101, enabled: false } });
      }
      if (init.method === 'DELETE') {
        expect(url).toBe(`/api/manage/ups/${identity.uid}/monitor`);
        expect(init.body).toBeUndefined();
        deleted = true;
        return new Response(null, { status: 204 });
      }
      expect(url).toBe(`/api/manage/ups/${identity.uid}`);
      return Response.json({ ...identity, monitor: deleted ? null : identity.monitor });
    });
    expect(await api.updateMonitor({ uid: identity.uid, monitor: { mode: 'specified', recentN: 101, enabled: false }, signal }))
      .toMatchObject({ status: 'success', data: { monitor: { mode: 'specified', recentN: 101, enabled: false } } });
    expect(await api.deleteMonitor({ uid: identity.uid, signal })).toEqual({ status: 'success', data: undefined });
    expect(await api.getUp({ uid: identity.uid, signal })).toMatchObject({ status: 'success', data: { uid: identity.uid, name: '测试 UP', monitor: null } });
  });
  it('HTTP 错误仅映射白名单固定提示，坏 JSON 和任意异常不泄漏秘密', async () => {
    const cases = [
      [422, 'INVALID_INPUT', '输入不合法，请检查后重试。'],
      [409, 'ALREADY_MONITORED', '该 UID 已有监控配置。'],
      [404, 'NOT_FOUND', '身份或监控配置不存在，请重新读取。'],
      [502, 'PROFILE_UNAVAILABLE', '未取得 UP 资料，请重试。'],
      [503, 'STORAGE_UNAVAILABLE', '配置存储暂不可用，请重试。'],
      [500, 'INTERNAL_ERROR', '管理服务暂不可用，请重试。'],
    ] as const;
    for (const [status, code, message] of cases) {
      const api = createManagementApi(async () => Response.json({ error: { code, message: 'SECRET_TOKEN' } }, { status }));
      expect(await api.listUps({ signal })).toEqual({ status: 'error', message });
    }
    for (const transport of [
      async () => Response.json({ error: { code: 'SECRET_TOKEN', message: 'SECRET_TOKEN' } }, { status: 502 }),
      async () => new Response('SECRET_TOKEN', { status: 200 }),
      async () => { throw new Error('SECRET_TOKEN'); },
    ]) {
      const result = await createManagementApi(transport).listUps({ signal });
      expect(result).toEqual({ status: 'error', message: '管理接口响应异常，请重试。' });
      expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
    }
  });
  it('新增仅传字符串 UID，拒绝非法 UID 且不发出请求', async () => {
    let requests = 0;
    const api = createManagementApi(async (url, init) => {
      requests++;
      expect(url).toBe('/api/manage/ups');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(init.body).toBe('{"uid":"900719925474099312345"}');
      return Response.json(identity, { status: 201 });
    });
    for (const uid of ['', ' 123', '123 ', '123\n', '123\r\n', '01', '0', '-1', '+1', '1.2', '１２３', '1'.repeat(129)]) {
      expect(await api.addUp({ uid, signal })).toMatchObject({ status: 'error' });
    }
    // @ts-expect-error UID 数字即使来自 JS 调用也必须拒绝。
    expect(await api.addUp({ uid: 123, signal })).toMatchObject({ status: 'error' });
    expect(requests).toBe(0);
    expect(await api.addUp({ uid: identity.uid, signal })).toMatchObject({ status: 'success', data: { uid: identity.uid } });
    expect(requests).toBe(1);
  });
  it('从同源 HTTP 读取身份与未检查状态，保留大 UID 字符串', async () => {
    const transport: ManagementTransport = async (url, init) => {
      expect(url).toBe('/api/manage/ups');
      expect(init.method).toBe('GET');
      expect(init.signal).toBe(signal);
      return Response.json({ ups: [identity] });
    };
    expect(await createManagementApi(transport).listUps({ signal })).toEqual({ status: 'success', data: [{
      uid: '900719925474099312345', name: '测试 UP', avatarUrl: 'https://example.test/avatar.png',
      monitor: { mode: 'recent', recentN: 10, enabled: true, lastCheckedAt: null, lastSucceededAt: null },
    }] });
  });
});
