import { describe, expect, it, vi } from 'vitest';
import {
  authenticationRequiredMessage, createManagementApi, invalidTargetMessage, invalidUidMessage,
  type ManagementTransport,
} from '../../src/manage/managementApi';
import { checkDto, discoveryDto } from '../fixtures/management-dto';

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

const discovered = {
  uid, mode: 'recent', recentN: 2, enabled: true, active: true, status: 'discovered',
  attempt: {
    recentN: 2, startedAt: '2026-10-24T19:08:27+00:00', finishedAt: '2026-10-24T19:08:28+00:00',
    ids: ['9007199254740993123'], error: null,
  },
  trustedResult: {
    recentN: 2, ids: ['9007199254740993123', '900707'], exhausted: false,
    discoveredAt: '2026-10-24T19:08:28+00:00',
  },
  currentIds: ['9007199254740993123', '900707'],
  retryable: false,
  incomplete: false,
} as const;

describe('检查与发现状态读取', () => {
  it('读取发现状态映射已保存模式、本轮尝试与可信窗口', async () => {
    const { transport, calls } = transportOf(Response.json(discoveryDto()));
    expect(await createManagementApi(transport).readDiscovery({ uid, signal: signal() }))
      .toEqual({ status: 'success', data: discovered });
    expect(calls[0]!.url).toBe(`/api/manage/ups/${uid}/discovery`);
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('非启用近期的发现状态不带窗口，也不声称可重试', async () => {
    const body = discoveryDto({
      mode: 'specified', recent_n: 10, active: false, status: 'undiscovered',
      attempt: null, trusted_result: null, current_ids: [], retryable: false, incomplete: true,
    });
    const { transport } = transportOf(Response.json(body));
    expect(await createManagementApi(transport).readDiscovery({ uid, signal: signal() }))
      .toEqual({ status: 'success', data: {
        uid, mode: 'specified', recentN: 10, enabled: true, active: false, status: 'undiscovered',
        attempt: null, trustedResult: null, currentIds: [], retryable: false, incomplete: true,
      } });
  });

  it('发现失败时保留历史可信结果并标记可重试', async () => {
    const body = discoveryDto({
      status: 'failed',
      attempt: {
        recent_n: 2, started_at: '2026-10-24T19:10:00+00:00', finished_at: '2026-10-24T19:10:01+00:00',
        ids: ['9007199254740993123'], error: 'SOURCE_UNAVAILABLE',
      },
      retryable: true, incomplete: true,
    });
    const { transport } = transportOf(Response.json(body));
    const result = await createManagementApi(transport).readDiscovery({ uid, signal: signal() });
    expect(result.status).toBe('success');
    expect(result.status === 'success' && result.data.attempt?.error).toBe('SOURCE_UNAVAILABLE');
    expect(result.status === 'success' && result.data.trustedResult?.ids).toEqual(['9007199254740993123', '900707']);
    expect(result.status === 'success' && result.data.retryable).toBe(true);
  });

  it('自相矛盾的发现状态整体判为无效', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['启用标志与模式不符', discoveryDto({ mode: 'specified', active: false })],
      ['模式与 N 矛盾', discoveryDto({ mode: 'recent', recent_n: null })],
      ['已发现却没有可信结果', discoveryDto({ trusted_result: null, incomplete: true })],
      ['当前窗口与可信结果不一致', discoveryDto({ current_ids: ['900707'] })],
      ['未开始却有本轮尝试', discoveryDto({ status: 'undiscovered', incomplete: true })],
      ['进行中却有完成时间', discoveryDto({ status: 'running', retryable: false, incomplete: true })],
      ['失败却没有错误码', discoveryDto({ status: 'failed', retryable: true, incomplete: true })],
      ['可重试标志与推导不符', discoveryDto({
        status: 'failed', retryable: false, incomplete: true,
        attempt: {
          recent_n: 2, started_at: '2026-10-24T19:10:00+00:00', finished_at: '2026-10-24T19:10:01+00:00',
          ids: [], error: 'SOURCE_UNAVAILABLE',
        },
      })],
      ['未完成标志与推导不符', discoveryDto({ incomplete: true })],
      ['可信结果未达 N 却非耗尽', discoveryDto({
        trusted_result: {
          recent_n: 2, ids: ['9007199254740993123'], exhausted: false,
          discovered_at: '2026-10-24T19:08:28+00:00',
        },
        current_ids: ['9007199254740993123'],
      })],
      ['未知发现错误码', discoveryDto({ status: 'failed', retryable: true, incomplete: true,
        attempt: {
          recent_n: 2, started_at: '2026-10-24T19:10:00+00:00', finished_at: '2026-10-24T19:10:01+00:00',
          ids: [], error: 'SOMETHING_NEW',
        } })],
    ];
    for (const [label, body] of cases) {
      const { transport } = transportOf(Response.json(body));
      expect(await createManagementApi(transport).readDiscovery({ uid, signal: signal() }), label)
        .toEqual({ status: 'error', message: invalidResponseMessage });
    }
  });

  it('发现状态需与请求 UID 一致，并且 UID 本地优先校验', async () => {
    const { transport } = transportOf(Response.json(discoveryDto({ uid: '456' })));
    expect(await createManagementApi(transport).readDiscovery({ uid, signal: signal() }))
      .toEqual({ status: 'error', message: invalidResponseMessage });

    const { transport: unused, calls } = transportOf();
    expect(await createManagementApi(unused).readDiscovery({ uid: '0123', signal: signal() }))
      .toEqual({ status: 'error', message: invalidUidMessage });
    expect(calls).toHaveLength(0);
  });

  it('读取检查状态映射分项、时间与封闭错误码', async () => {
    const { transport, calls } = transportOf(Response.json({ checks: [checkDto()] }));
    expect(await createManagementApi(transport).listChecks({ uid, signal: signal() }))
      .toEqual({ status: 'success', data: [{
        id: '900707', active: true, checkStatus: 'unchanged', work: 'pending', revision: 1,
        lastCheckedAt: '2026-10-24T19:08:27+00:00', lastSucceededAt: null,
        textLastSucceededAt: '2026-10-24T19:08:30+00:00', mediaLastSucceededAt: null,
        commentMediaLastSucceededAt: null, mediaErrors: ['MEDIA_UPLOAD_FAILED'], commentMediaErrors: [],
        observedVersion: 'v1', syncedVersion: null, editStatus: 'observed',
        sourceCommentCount: 0, localCommentCount: 0, localReplyCount: 0,
        commentCountStatus: null, commentsLastAttempt: 'failed', syncedCommentCount: null,
        rootCommentsLastSucceededAt: null, repliesLastSucceededAt: null, commentsLastSucceededAt: null,
        rootCommentsError: 'ROOT_COMMENTS_FAILED', repliesError: null, commentsError: 'ROOT_COMMENTS_FAILED',
        checkError: null, syncError: 'SYNC_INCOMPLETE',
        parts: { text: 'success', media: 'pending', comments: 'failed', replies: 'success', comment_media: 'pending' },
      }] });
    expect(calls[0]!.url).toBe(`/api/manage/ups/${uid}/checks`);
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('检查列表拒绝重复 ID 与未知分项状态', async () => {
    const cases: [string, Record<string, unknown>][] = [
      ['重复 ID', { checks: [checkDto(), checkDto()] }],
      ['未知检查状态', { checks: [checkDto({ check_status: 'maybe' })] }],
      ['未知执行状态', { checks: [checkDto({ work: 'archived' })] }],
      ['未知分项状态', { checks: [checkDto({ parts: { ...checkDto().parts, text: 'done' } })] }],
      ['未知同步错误码', { checks: [checkDto({ sync_error: 'SYNC_FAILED' })] }],
      ['未知媒体错误码', { checks: [checkDto({ media_errors: ['MEDIA_LOST'] })] }],
      ['负数计数', { checks: [checkDto({ local_comment_count: -1 })] }],
    ];
    for (const [label, body] of cases) {
      const { transport } = transportOf(Response.json(body));
      expect(await createManagementApi(transport).listChecks({ uid, signal: signal() }), label)
        .toEqual({ status: 'error', message: invalidResponseMessage });
    }
  });

  it('检查与发现的错误响应只按固定错误码与状态映射', async () => {
    const cases: [number, string, string][] = [
      [404, 'NOT_FOUND', '身份或监控配置不存在，请重新读取。'],
      [422, 'INVALID_INPUT', '输入不合法，请检查后重试。'],
    ];
    for (const [status, code, message] of cases) {
      for (const run of [
        (api: ReturnType<typeof createManagementApi>) => api.readDiscovery({ uid, signal: signal() }),
        (api: ReturnType<typeof createManagementApi>) => api.listChecks({ uid, signal: signal() }),
      ]) {
        const { transport } = transportOf(Response.json({ error: { code, message: 'SECRET_TOKEN' } }, { status }));
        const result = await run(createManagementApi(transport));
        expect(result).toEqual({ status: 'error', message });
        expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
      }
    }
  });
});

describe('通知三态的读取与切换', () => {
  function notificationDto(overrides: Record<string, unknown> = {}) {
    return { state: 'all', pending: 0, ...overrides };
  }

  it('读取状态映射三态与待发条数，只发 GET', async () => {
    const { transport, calls } = transportOf(Response.json(notificationDto({ pending: 3 })));
    expect(await createManagementApi(transport).readNotification({ signal: signal() }))
      .toEqual({ status: 'success', data: { state: 'all', pending: 3 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/manage/notifications');
    expect(calls[0]!.init.method).toBe('GET');
  });

  it('切换提交完整 {state} 并返回后端新状态', async () => {
    const { transport, calls } = transportOf(
      Response.json(notificationDto({ state: 'system_only', pending: 5 })));
    expect(await createManagementApi(transport).updateNotification({ state: 'system_only', signal: signal() }))
      .toEqual({ status: 'success', data: { state: 'system_only', pending: 5 } });
    expect(calls[0]!.url).toBe('/api/manage/notifications');
    expect(calls[0]!.init.method).toBe('PUT');
    expect(calls[0]!.init.body).toBe('{"state":"system_only"}');
    expect(new Headers(calls[0]!.init.headers).get('Content-Type')).toBe('application/json');
  });

  it('状态形状或状态码不符整体判为无效', async () => {
    const cases: [number, Record<string, unknown>][] = [
      [200, { state: 'paused', pending: 0 }],
      [200, { state: 'ALL', pending: 0 }],
      [200, { state: true, pending: 0 }],
      [200, { enabled: true, pending: 0 }],
      [200, { state: 'all', pending: -1 }],
      [200, { state: 'all', pending: 1.5 }],
      [200, { state: 'all' }],
      [200, { state: 'all', pending: null }],
      [201, { state: 'all', pending: 0 }],
      [202, { state: 'all', pending: 0 }],
    ];
    for (const [status, body] of cases) {
      for (const run of [
        (api: ReturnType<typeof createManagementApi>) => api.readNotification({ signal: signal() }),
        (api: ReturnType<typeof createManagementApi>) =>
          api.updateNotification({ state: 'all', signal: signal() }),
      ]) {
        const { transport } = transportOf(Response.json(body, { status }));
        expect(await run(createManagementApi(transport)), `${status} ${JSON.stringify(body)}`)
          .toEqual({ status: 'error', message: invalidResponseMessage });
      }
    }
  });

  it('写失败按固定错误码映射，不回显响应正文', async () => {
    const { transport } = transportOf(Response.json(
      { error: { code: 'STORAGE_UNAVAILABLE', message: 'SECRET_TOKEN' } }, { status: 503 }));
    const result = await createManagementApi(transport).updateNotification({ state: 'all', signal: signal() });
    expect(result).toEqual({ status: 'error', message: '配置存储暂不可用，请重试。' });
    expect(JSON.stringify(result)).not.toContain('SECRET_TOKEN');
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
    { name: 'readDiscovery', path: `/api/manage/ups/${uid}/discovery`, method: 'GET',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.readDiscovery({ uid, signal }) },
    { name: 'listChecks', path: `/api/manage/ups/${uid}/checks`, method: 'GET',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.listChecks({ uid, signal }) },
    { name: 'readNotification', path: '/api/manage/notifications', method: 'GET',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.readNotification({ signal }) },
    { name: 'updateNotification', path: '/api/manage/notifications', method: 'PUT',
      run: (api: ReturnType<typeof createManagementApi>, signal: AbortSignal) =>
        api.updateNotification({ state: 'all', signal }) },
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
