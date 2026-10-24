import { isValidId } from '../data/identifiers';
import { isRecord as record } from '../data/guards';
import { timestamp } from '../data/timestamp';
import { parseCheck, type TargetCheck } from '../data/checkStatus';
import { parseDiscovery, type DiscoveryState } from './discoveryState';

/**
 * 管理接口的生产 Adapter：只把 HTTP 传输替换成测试替身，JSON 校验与固定安全文案
 * 始终走这里。展示层拿到的都是映射后的类型，不理解 snake_case 或原始错误码。
 */
export interface MonitorConfig {
  readonly mode: 'recent' | 'specified';
  readonly recentN: number;
  readonly enabled: boolean;
}
export interface Monitor extends MonitorConfig {
  readonly lastCheckedAt: string | null;
  readonly lastSucceededAt: string | null;
}
export interface ManagedUp {
  readonly uid: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly monitor: Monitor | null;
}
export interface ManagedTarget { readonly id: string }

export type ManagementResult<T> =
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'cancelled' };
export type ManagementTransport = (url: string, init: RequestInit) => Promise<Response>;

/** 反代 401 的固定提示：不读取、不回显代理正文，也不代表应用内已有账号系统。 */
export const authenticationRequiredMessage = '管理访问需要身份验证，请刷新页面重新认证。';
export const invalidUidMessage = 'UID 须为无前导零的正整数字符串，最多 128 位。';
export const invalidMonitorMessage = '近期 N 须为正的安全整数，模式与启停须有效。';
export const invalidTargetMessage = '动态 ID 须为无前导零的正整数字符串，最多 128 位。';
export const isValidUid = isValidId;
export const isValidTargetId = isValidId;

const invalidResponse = { status: 'error', message: '管理接口响应异常，请重试。' } as const;

function avatar(value: unknown): value is string | null {
  if (value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function parseUp(value: unknown): ManagedUp | null {
  if (!record(value) || !isValidUid(value.uid)
    || !(value.name === null || typeof value.name === 'string')
    || !avatar(value.avatar_url)) return null;
  let monitor: Monitor | null = null;
  if (value.monitor !== null) {
    const m = value.monitor;
    if (!record(m) || (m.mode !== 'recent' && m.mode !== 'specified')
      || typeof m.recent_n !== 'number' || !Number.isSafeInteger(m.recent_n) || m.recent_n < 1
      || typeof m.enabled !== 'boolean' || !timestamp(m.last_checked_at) || !timestamp(m.last_succeeded_at)) {
      return null;
    }
    monitor = {
      mode: m.mode, recentN: m.recent_n, enabled: m.enabled,
      lastCheckedAt: m.last_checked_at, lastSucceededAt: m.last_succeeded_at,
    };
  }
  return { uid: value.uid, name: value.name, avatarUrl: value.avatar_url, monitor };
}

function monitorBody(monitor: MonitorConfig) {
  return JSON.stringify({ mode: monitor.mode, recent_n: monitor.recentN, enabled: monitor.enabled });
}

function validMonitorConfig(monitor: MonitorConfig | null | undefined): monitor is MonitorConfig {
  return !!monitor && (monitor.mode === 'recent' || monitor.mode === 'specified')
    && Number.isSafeInteger(monitor.recentN) && monitor.recentN >= 1
    && typeof monitor.enabled === 'boolean';
}

function httpError(body: unknown, status: number): ManagementResult<never> {
  if (!record(body) || !record(body.error)) return invalidResponse;
  // 不读取 message；未知错误码、错误码与状态不符均不回显响应内容。
  switch (body.error.code) {
    case 'INVALID_INPUT': return status === 422
      ? { status: 'error', message: '输入不合法，请检查后重试。' } : invalidResponse;
    case 'ALREADY_MONITORED': return status === 409
      ? { status: 'error', message: '该 UID 已有监控配置。' } : invalidResponse;
    case 'NOT_FOUND': return status === 404
      ? { status: 'error', message: '身份或监控配置不存在，请重新读取。' } : invalidResponse;
    case 'TARGET_AUTHOR_MISMATCH': return status === 409
      ? { status: 'error', message: '动态作者与所选 UP 不符。' } : invalidResponse;
    case 'TARGET_UNVERIFIED': return status === 502
      ? { status: 'error', message: '无法确认动态归属。' } : invalidResponse;
    case 'PROFILE_UNAVAILABLE': return status === 502
      ? { status: 'error', message: '未取得 UP 资料，请重试。' } : invalidResponse;
    case 'STORAGE_UNAVAILABLE': return status === 503
      ? { status: 'error', message: '配置存储暂不可用，请重试。' } : invalidResponse;
    case 'INTERNAL_ERROR': return status === 500
      ? { status: 'error', message: '管理服务暂不可用，请重试。' } : invalidResponse;
    default: return invalidResponse;
  }
}

/** 只替换 HTTP 传输；取消优先于任何响应，包括反代返回的 HTML 401。 */
export function createManagementApi(transport: ManagementTransport = (url, init) => fetch(url, init)) {
  async function request(url: string, init: RequestInit & { signal: AbortSignal }): Promise<ManagementResult<Response>> {
    if (init.signal.aborted) return { status: 'cancelled' };
    const response = await transport(url, init);
    if (init.signal.aborted) return { status: 'cancelled' };
    if (response.status === 401) return { status: 'error', message: authenticationRequiredMessage };
    return { status: 'success', data: response };
  }

  async function upRequest(
    uid: string, signal: AbortSignal, method: 'GET' | 'PATCH', monitor?: MonitorConfig,
  ): Promise<ManagementResult<ManagedUp>> {
    if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
    try {
      if (signal.aborted) return { status: 'cancelled' };
      const result = await request(`/api/manage/ups/${uid}${method === 'PATCH' ? '/monitor' : ''}`, {
        method, signal,
        ...(monitor ? { headers: { 'Content-Type': 'application/json' }, body: monitorBody(monitor) } : {}),
      });
      if (signal.aborted) return { status: 'cancelled' };
      if (result.status !== 'success') return result;
      const response = result.data;
      const body: unknown = await response.json();
      if (signal.aborted) return { status: 'cancelled' };
      if (!response.ok) return httpError(body, response.status);
      const up = parseUp(body);
      return response.status === 200 && up?.uid === uid && (method === 'GET' || up.monitor !== null)
        ? { status: 'success', data: up } : invalidResponse;
    } catch {
      return signal.aborted ? { status: 'cancelled' } : invalidResponse;
    }
  }

  /** 只返回 204 的删除请求：其他状态仍解固定错误码，不静默成功。 */
  async function deleteRequest(url: string, signal: AbortSignal): Promise<ManagementResult<void>> {
    try {
      if (signal.aborted) return { status: 'cancelled' };
      const result = await request(url, { method: 'DELETE', signal });
      if (signal.aborted) return { status: 'cancelled' };
      if (result.status !== 'success') return result;
      const response = result.data;
      if (response.status === 204) return { status: 'success', data: undefined };
      const body: unknown = await response.json();
      if (signal.aborted) return { status: 'cancelled' };
      return response.ok ? invalidResponse : httpError(body, response.status);
    } catch {
      return signal.aborted ? { status: 'cancelled' } : invalidResponse;
    }
  }

  /** 只读 GET：统一处理取消优先、JSON 解析与固定错误映射，响应状态码交给调用方判。 */
  async function getJson(
    url: string, signal: AbortSignal,
  ): Promise<ManagementResult<{ readonly status: number; readonly body: unknown }>> {
    try {
      if (signal.aborted) return { status: 'cancelled' };
      const result = await request(url, { method: 'GET', signal });
      if (signal.aborted) return { status: 'cancelled' };
      if (result.status !== 'success') return result;
      const response = result.data;
      const body: unknown = await response.json();
      if (signal.aborted) return { status: 'cancelled' };
      if (!response.ok) return httpError(body, response.status);
      return { status: 'success', data: { status: response.status, body } };
    } catch {
      return signal.aborted ? { status: 'cancelled' } : invalidResponse;
    }
  }

  /** 目标请求：GET 不带 ID，POST 提交 `{id}`，DELETE 只解除关联。 */
  async function targetRequest(
    uid: string, signal: AbortSignal, method: 'GET' | 'POST' | 'DELETE', id?: string,
  ): Promise<ManagementResult<unknown>> {
    if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
    if (method !== 'GET') {
      if (!isValidTargetId(id)) return { status: 'error', message: invalidTargetMessage };
      if (method === 'DELETE') return deleteRequest(`/api/manage/ups/${uid}/targets/${id}`, signal);
    }
    try {
      if (signal.aborted) return { status: 'cancelled' };
      const result = await request(`/api/manage/ups/${uid}/targets`, {
        method, signal,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) } : {}),
      });
      if (signal.aborted) return { status: 'cancelled' };
      if (result.status !== 'success') return result;
      const response = result.data;
      const body: unknown = await response.json();
      if (signal.aborted) return { status: 'cancelled' };
      if (!response.ok) return httpError(body, response.status);
      return response.status === (method === 'POST' ? 201 : 200)
        ? { status: 'success', data: body } : invalidResponse;
    } catch {
      return signal.aborted ? { status: 'cancelled' } : invalidResponse;
    }
  }

  return {
    /** 身份与监控状态列表；删除配置的身份仍返回（monitor 为 null）。 */
    async listUps({ signal }: { readonly signal: AbortSignal }): Promise<ManagementResult<readonly ManagedUp[]>> {
      try {
        if (signal.aborted) return { status: 'cancelled' };
        const result = await request('/api/manage/ups', { method: 'GET', signal });
        if (signal.aborted) return { status: 'cancelled' };
        if (result.status !== 'success') return result;
        const response = result.data;
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        if (!response.ok) return httpError(body, response.status);
        if (response.status !== 200 || !record(body) || !Array.isArray(body.ups)) return invalidResponse;
        const ups: ManagedUp[] = [];
        for (const raw of body.ups) {
          const up = parseUp(raw);
          if (!up || ups.some(existing => existing.uid === up.uid)) return invalidResponse;
          ups.push(up);
        }
        return { status: 'success', data: ups };
      } catch {
        return signal.aborted ? { status: 'cancelled' } : invalidResponse;
      }
    },
    /** 新增只提交 UID；昵称与头像由后端取得，失败不产生身份。 */
    async addUp({ uid, signal }: { readonly uid: string; readonly signal: AbortSignal }): Promise<ManagementResult<ManagedUp>> {
      if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
      try {
        if (signal.aborted) return { status: 'cancelled' };
        const result = await request('/api/manage/ups', {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid }),
        });
        if (signal.aborted) return { status: 'cancelled' };
        if (result.status !== 'success') return result;
        const response = result.data;
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        if (!response.ok) return httpError(body, response.status);
        const up = parseUp(body);
        return response.status === 201 && up?.uid === uid && up.monitor !== null
          ? { status: 'success', data: up } : invalidResponse;
      } catch {
        return signal.aborted ? { status: 'cancelled' } : invalidResponse;
      }
    },
    /** 启停与配置保存都提交完整配置：后端不做局部更新。 */
    async updateMonitor(
      { uid, monitor, signal }: { readonly uid: string; readonly monitor: MonitorConfig; readonly signal: AbortSignal },
    ): Promise<ManagementResult<ManagedUp>> {
      if (!validMonitorConfig(monitor)) return { status: 'error', message: invalidMonitorMessage };
      return upRequest(uid, signal, 'PATCH', monitor);
    },
    /** 只删除监控配置：身份与已有归档保留，删除后可重新添加。 */
    async deleteMonitor(
      { uid, signal }: { readonly uid: string; readonly signal: AbortSignal },
    ): Promise<ManagementResult<void>> {
      if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
      return deleteRequest(`/api/manage/ups/${uid}/monitor`, signal);
    },
    /** 近期发现与当前窗口：只读已保存状态，不启动发现、归档或轮询。 */
    async readDiscovery(
      { uid, signal }: { readonly uid: string; readonly signal: AbortSignal },
    ): Promise<ManagementResult<DiscoveryState>> {
      if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
      const result = await getJson(`/api/manage/ups/${uid}/discovery`, signal);
      if (result.status !== 'success') return result;
      const discovery = parseDiscovery(result.data.body);
      return result.data.status === 200 && discovery?.uid === uid
        ? { status: 'success', data: discovery } : invalidResponse;
    },
    /** 目标检查与归档状态：只读持久状态，不触发检查或同步。 */
    async listChecks(
      { uid, signal }: { readonly uid: string; readonly signal: AbortSignal },
    ): Promise<ManagementResult<readonly TargetCheck[]>> {
      if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
      const result = await getJson(`/api/manage/ups/${uid}/checks`, signal);
      if (result.status !== 'success') return result;
      const body = result.data.body;
      if (result.data.status !== 200 || !record(body) || !Array.isArray(body.checks)) return invalidResponse;
      const checks: TargetCheck[] = [];
      for (const raw of body.checks) {
        const check = parseCheck(raw, timestamp);
        if (!check || checks.some(existing => existing.id === check.id)) return invalidResponse;
        checks.push(check);
      }
      return { status: 'success', data: checks };
    },
    /** 指定模式下的关联目标：只含字符串 ID，归属校验由服务端完成。 */
    async listTargets(
      { uid, signal }: { readonly uid: string; readonly signal: AbortSignal },
    ): Promise<ManagementResult<readonly ManagedTarget[]>> {
      const result = await targetRequest(uid, signal, 'GET');
      if (result.status !== 'success') return result;
      const body = result.data;
      if (!record(body) || !Array.isArray(body.targets)) return invalidResponse;
      const targets: ManagedTarget[] = [];
      for (const item of body.targets) {
        if (!record(item) || !isValidId(item.id) || targets.some(target => target.id === item.id)) {
          return invalidResponse;
        }
        targets.push({ id: item.id });
      }
      return { status: 'success', data: targets };
    },
    /** 添加前由服务端复核作者，作者不符与无法确认是不同结果。 */
    async addTarget(
      { uid, id, signal }: { readonly uid: string; readonly id: string; readonly signal: AbortSignal },
    ): Promise<ManagementResult<ManagedTarget>> {
      const result = await targetRequest(uid, signal, 'POST', id);
      if (result.status !== 'success') return result;
      return record(result.data) && result.data.id === id
        ? { status: 'success', data: { id } } : invalidResponse;
    },
    /** 移除只解除关联，不删除已归档内容。 */
    async deleteTarget(
      { uid, id, signal }: { readonly uid: string; readonly id: string; readonly signal: AbortSignal },
    ): Promise<ManagementResult<void>> {
      const result = await targetRequest(uid, signal, 'DELETE', id);
      return result.status === 'success' ? { status: 'success', data: undefined } : result;
    },
  };
}

export type ManagementApi = ReturnType<typeof createManagementApi>;
