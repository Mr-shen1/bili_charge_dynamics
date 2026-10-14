import { isRecord } from '../data/guards';
import { isValidId } from '../data/identifiers';
import { timestamp } from '../data/timestamp';

export type DiscoveryError = 'SOURCE_UNAVAILABLE' | 'SIGNAL_INVALID' | 'PAGINATION_INVALID'
  | 'DISCOVERY_STOPPED' | 'DISCOVERY_INTERRUPTED';
export interface DiscoveryAttempt {
  readonly recentN: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly ids: readonly string[];
  readonly error: DiscoveryError | null;
}
export interface TrustedDiscovery {
  readonly recentN: number;
  readonly ids: readonly string[];
  readonly exhausted: boolean;
  readonly discoveredAt: string;
}
export interface DiscoveryState {
  readonly uid: string;
  readonly mode: 'recent' | 'specified' | null;
  readonly recentN: number | null;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly status: 'undiscovered' | 'running' | 'discovered' | 'failed';
  readonly attempt: DiscoveryAttempt | null;
  readonly trustedResult: TrustedDiscovery | null;
  readonly currentIds: readonly string[];
  readonly retryable: boolean;
  readonly incomplete: boolean;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isValidId) && new Set(value).size === value.length;
}
function errorCode(value: unknown): value is DiscoveryError | null {
  return value === null || value === 'SOURCE_UNAVAILABLE' || value === 'SIGNAL_INVALID'
    || value === 'PAGINATION_INVALID' || value === 'DISCOVERY_STOPPED' || value === 'DISCOVERY_INTERRUPTED';
}

/** 只提取白名单字段；本轮部分候选与历史可信结果不能互相代替。 */
export function parseDiscovery(value: unknown): DiscoveryState | null {
  if (!isRecord(value) || !isValidId(value.uid)
    || (value.mode !== 'recent' && value.mode !== 'specified' && value.mode !== null)
    || !(value.recent_n === null || positiveInteger(value.recent_n))
    || typeof value.enabled !== 'boolean' || typeof value.active !== 'boolean'
    || typeof value.retryable !== 'boolean' || typeof value.incomplete !== 'boolean'
    || (value.status !== 'undiscovered' && value.status !== 'running' && value.status !== 'discovered' && value.status !== 'failed')
    || !ids(value.current_ids)) return null;
  if ((value.mode === null) !== (value.recent_n === null)
    || (value.mode === null && value.enabled)
    || value.active !== (value.enabled && value.mode === 'recent')
    || (!value.active && (value.current_ids.length > 0 || value.retryable))) return null;
  let attempt: DiscoveryAttempt | null = null;
  if (value.attempt !== null) {
    const a = value.attempt;
    if (!isRecord(a) || !positiveInteger(a.recent_n) || !ids(a.ids) || a.ids.length > a.recent_n
      || typeof a.started_at !== 'string' || !timestamp(a.started_at)
      || !timestamp(a.finished_at) || !errorCode(a.error)) return null;
    attempt = { recentN: a.recent_n, ids: a.ids, startedAt: a.started_at, finishedAt: a.finished_at, error: a.error };
  }
  let trustedResult: TrustedDiscovery | null = null;
  if (value.trusted_result !== null) {
    const t = value.trusted_result;
    if (!isRecord(t) || !positiveInteger(t.recent_n) || !ids(t.ids) || typeof t.exhausted !== 'boolean'
      || t.ids.length > t.recent_n || (!t.exhausted && t.ids.length !== t.recent_n)
      || typeof t.discovered_at !== 'string' || !timestamp(t.discovered_at)) return null;
    trustedResult = { recentN: t.recent_n, ids: t.ids, exhausted: t.exhausted, discoveredAt: t.discovered_at };
  }
  const currentIds = value.active && trustedResult ? trustedResult.ids : [];
  if (value.current_ids.length !== currentIds.length
    || value.current_ids.some((id, index) => id !== currentIds[index])) return null;
  if (value.status === 'undiscovered' ? attempt !== null : attempt === null) return null;
  if (attempt) {
    if (value.status === 'running') {
      if (attempt.finishedAt !== null || attempt.error !== null) return null;
    } else {
      if (attempt.finishedAt === null
        || (value.status === 'failed' ? attempt.error === null : attempt.error !== null)) return null;
    }
  }
  if (value.status === 'discovered' && trustedResult === null) return null;
  const incomplete = value.status !== 'discovered' || trustedResult === null || trustedResult.recentN !== value.recent_n;
  const retryable = value.active && value.status !== 'running' && incomplete;
  if (value.incomplete !== incomplete || value.retryable !== retryable) return null;
  return { uid: value.uid, mode: value.mode, recentN: value.recent_n, enabled: value.enabled, active: value.active,
    status: value.status, attempt, trustedResult, currentIds: value.current_ids,
    retryable: value.retryable, incomplete: value.incomplete };
}
