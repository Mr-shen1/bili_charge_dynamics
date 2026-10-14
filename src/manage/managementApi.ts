import { isValidId } from '../data/identifiers';
import { isRecord as record } from '../data/guards';
import { parseCheck, type ManagedCheck } from './checkStatus';
import { timestamp } from '../data/timestamp';

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
export const invalidTargetMessage = '动态 ID 须为无前导零的正整数字符串，最多 128 位。';
export type ManagementResult<T> =
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'cancelled' };
export type ManagementTransport = (url: string, init: RequestInit) => Promise<Response>;

export const invalidUidMessage = 'UID 须为无前导零的正整数字符串，最多 128 位。';
export const isValidUid = isValidId;
function avatar(value: unknown): value is string | null {
  if (value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}
function parseUp(value: unknown): ManagedUp | null {
  if (!record(value) || !isValidUid(value.uid)
    || !(value.name === null || typeof value.name === 'string')
    || !avatar(value.avatar_url)) return null;
  let monitor: Monitor | null = null;
  if (value.monitor !== null) {
    const m = value.monitor;
    if (!record(m) || (m.mode !== 'recent' && m.mode !== 'specified')
      || typeof m.recent_n !== 'number' || !Number.isSafeInteger(m.recent_n) || m.recent_n < 1
      || typeof m.enabled !== 'boolean' || !timestamp(m.last_checked_at) || !timestamp(m.last_succeeded_at)) return null;
    monitor = { mode: m.mode, recentN: m.recent_n, enabled: m.enabled,
      lastCheckedAt: m.last_checked_at, lastSucceededAt: m.last_succeeded_at };
  }
  return { uid: value.uid, name: value.name, avatarUrl: value.avatar_url, monitor };
}
const invalidResponse = { status: 'error', message: '管理接口响应异常，请重试。' } as const;
function httpError(body: unknown, status: number): ManagementResult<never> {
  if (!record(body) || !record(body.error)) return invalidResponse;
  // 不读取 message；未知错误码、错误码与状态不符均不回显响应内容。
  switch (body.error.code) {
    case 'INVALID_INPUT': return status === 422 ? { status: 'error', message: '输入不合法，请检查后重试。' } : invalidResponse;
    case 'ALREADY_MONITORED': return status === 409 ? { status: 'error', message: '该 UID 已有监控配置。' } : invalidResponse;
    case 'NOT_FOUND': return status === 404 ? { status: 'error', message: '身份或监控配置不存在，请重新读取。' } : invalidResponse;
    case 'TARGET_AUTHOR_MISMATCH': return status === 409 ? { status: 'error', message: '动态作者与所选 UP 不符。' } : invalidResponse;
    case 'TARGET_UNVERIFIED': return status === 502 ? { status: 'error', message: '无法确认动态归属。' } : invalidResponse;
    case 'PROFILE_UNAVAILABLE': return status === 502 ? { status: 'error', message: '未取得 UP 资料，请重试。' } : invalidResponse;
    case 'STORAGE_UNAVAILABLE': return status === 503 ? { status: 'error', message: '配置存储暂不可用，请重试。' } : invalidResponse;
    case 'INTERNAL_ERROR': return status === 500 ? { status: 'error', message: '管理服务暂不可用，请重试。' } : invalidResponse;
    default: return invalidResponse;
  }
}

/** 只替换 HTTP 传输；JSON 校验和安全文案始终经过生产映射。 */
export function createManagementApi(transport: ManagementTransport = (url, init) => fetch(url, init)) {
  async function upRequest(uid: string, signal: AbortSignal, method: 'GET' | 'PATCH', monitor?: MonitorConfig): Promise<ManagementResult<ManagedUp>> {
    if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
    try {
      if (signal.aborted) return { status: 'cancelled' };
      const response = await transport(`/api/manage/ups/${uid}${method === 'PATCH' ? '/monitor' : ''}`, {
        method, signal, ...(monitor ? { headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: monitor.mode, recent_n: monitor.recentN, enabled: monitor.enabled }) } : {}),
      });
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
  async function targetRequest(uid: string, signal: AbortSignal, method: 'GET' | 'POST' | 'DELETE', id?: string): Promise<ManagementResult<unknown>> {
    if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
    if (method !== 'GET' && !isValidId(id)) return { status: 'error', message: invalidTargetMessage };
    try {
      if (signal.aborted) return { status: 'cancelled' };
      const response = await transport(`/api/manage/ups/${uid}/targets${method === 'DELETE' ? `/${id}` : ''}`, {
        method, signal, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) } : {}),
      });
      if (signal.aborted) return { status: 'cancelled' };
      if (method === 'DELETE' && response.status === 204) return { status: 'success', data: undefined };
      const body: unknown = await response.json();
      if (signal.aborted) return { status: 'cancelled' };
      if (!response.ok) return httpError(body, response.status);
      return response.status === (method === 'POST' ? 201 : 200) && method !== 'DELETE'
        ? { status: 'success', data: body } : invalidResponse;
    } catch { return signal.aborted ? { status: 'cancelled' } : invalidResponse; }
  }
  return {
    async listChecks({ uid, signal }: { readonly uid: string; readonly signal: AbortSignal }): Promise<ManagementResult<readonly ManagedCheck[]>> {
      if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
      try {
        if (signal.aborted) return { status: 'cancelled' };
        const response = await transport(`/api/manage/ups/${uid}/checks`, { method: 'GET', signal });
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        if (!response.ok) return httpError(body, response.status);
        if (response.status !== 200 || !record(body) || !Array.isArray(body.checks)) return invalidResponse;
        const checks: ManagedCheck[] = [];
        for (const raw of body.checks) {
          const check = parseCheck(raw, timestamp);
          if (!check || checks.some(existing => existing.id === check.id)) return invalidResponse;
          checks.push(check);
        }
        return { status: 'success', data: checks };
      } catch { return signal.aborted ? { status: 'cancelled' } : invalidResponse; }
    },
    async listTargets({ uid, signal }: { readonly uid: string; readonly signal: AbortSignal }): Promise<ManagementResult<readonly ManagedTarget[]>> {
      const result = await targetRequest(uid, signal, 'GET');
      if (result.status !== 'success') return result;
      const body = result.data;
      if (!record(body) || !Array.isArray(body.targets)) return invalidResponse;
      const targets: ManagedTarget[] = [];
      for (const item of body.targets) {
        if (!record(item) || !isValidId(item.id) || targets.some(target => target.id === item.id)) return invalidResponse;
        targets.push({ id: item.id });
      }
      return { status: 'success', data: targets };
    },
    async addTarget({ uid, id, signal }: { readonly uid: string; readonly id: string; readonly signal: AbortSignal }): Promise<ManagementResult<ManagedTarget>> {
      const result = await targetRequest(uid, signal, 'POST', id);
      if (result.status !== 'success') return result;
      return record(result.data) && result.data.id === id ? { status: 'success', data: { id } } : invalidResponse;
    },
    async deleteTarget({ uid, id, signal }: { readonly uid: string; readonly id: string; readonly signal: AbortSignal }): Promise<ManagementResult<void>> {
      const result = await targetRequest(uid, signal, 'DELETE', id);
      return result.status === 'success' ? { status: 'success', data: undefined } : result;
    },
    getUp({ uid, signal }: { readonly uid: string; readonly signal: AbortSignal }) {
      return upRequest(uid, signal, 'GET');
    },
    async updateMonitor({ uid, monitor, signal }: { readonly uid: string; readonly monitor: MonitorConfig; readonly signal: AbortSignal }): Promise<ManagementResult<ManagedUp>> {
      if (!monitor || (monitor.mode !== 'recent' && monitor.mode !== 'specified')
        || !Number.isSafeInteger(monitor.recentN) || monitor.recentN < 1 || typeof monitor.enabled !== 'boolean') {
        return { status: 'error', message: '近期 N 须为正的安全整数，模式与启停须有效。' };
      }
      return upRequest(uid, signal, 'PATCH', monitor);
    },
    async deleteMonitor({ uid, signal }: { readonly uid: string; readonly signal: AbortSignal }): Promise<ManagementResult<void>> {
      if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
      try {
        if (signal.aborted) return { status: 'cancelled' };
        const response = await transport(`/api/manage/ups/${uid}/monitor`, { method: 'DELETE', signal });
        if (signal.aborted) return { status: 'cancelled' };
        if (response.status === 204) return { status: 'success', data: undefined };
        const body: unknown = await response.json();
        if (signal.aborted) return { status: 'cancelled' };
        return response.ok ? invalidResponse : httpError(body, response.status);
      } catch {
        return signal.aborted ? { status: 'cancelled' } : invalidResponse;
      }
    },
    async addUp({ uid, signal }: { readonly uid: string; readonly signal: AbortSignal }): Promise<ManagementResult<ManagedUp>> {
      if (!isValidUid(uid)) return { status: 'error', message: invalidUidMessage };
      try {
        if (signal.aborted) return { status: 'cancelled' };
        const response = await transport('/api/manage/ups', { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid }) });
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
    async listUps({ signal }: { readonly signal: AbortSignal }): Promise<ManagementResult<readonly ManagedUp[]>> {
      try {
        if (signal.aborted) return { status: 'cancelled' };
        const response = await transport('/api/manage/ups', { method: 'GET', signal });
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
  };
}
export type ManagementApi = ReturnType<typeof createManagementApi>;
export const managementApi = createManagementApi();
