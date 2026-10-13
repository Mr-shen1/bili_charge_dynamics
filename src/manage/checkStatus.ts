import type { ArchiveWorkState } from '../data/contracts';
import { isRecord } from '../data/guards';
import { isValidId } from '../data/identifiers';

export type CheckError = 'SOURCE_UNAVAILABLE' | 'SIGNAL_INVALID' | 'SYNC_INCOMPLETE';
export interface ManagedCheck {
  readonly id: string;
  readonly active: boolean;
  readonly checkStatus: 'unchecked' | 'checked' | 'unchanged' | 'failed';
  readonly work: 'pending' | 'running' | 'complete';
  readonly revision: number;
  readonly lastCheckedAt: string | null;
  readonly lastSucceededAt: string | null;
  readonly observedVersion: string | null;
  readonly syncedVersion: string | null;
  readonly editStatus: 'observed' | 'unknown' | 'error';
  readonly checkError: CheckError | null;
  readonly syncError: CheckError | null;
  readonly parts: Readonly<Record<'text' | 'media' | 'comments' | 'replies' | 'comment_media', ArchiveWorkState>>;
}
function workState(value: unknown): value is ArchiveWorkState {
  return value === 'pending' || value === 'success' || value === 'restricted' || value === 'failed';
}
function errorCode(value: unknown): value is CheckError | null {
  return value === null || value === 'SOURCE_UNAVAILABLE' || value === 'SIGNAL_INVALID' || value === 'SYNC_INCOMPLETE';
}
function version(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
export function parseCheck(value: unknown, timestamp: (value: unknown) => value is string | null): ManagedCheck | null {
  if (!isRecord(value) || !isValidId(value.id) || typeof value.active !== 'boolean'
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !timestamp(value.last_checked_at) || !timestamp(value.last_succeeded_at)
    || !errorCode(value.check_error) || !errorCode(value.sync_error)
    || !version(value.synced_version) || !isRecord(value.observed) || !isRecord(value.parts)) return null;
  const observed = value.observed;
  if (observed.observed_version !== undefined && !version(observed.observed_version)) return null;
  const editStatus = observed.edit_status ?? 'unknown';
  if (editStatus !== 'observed' && editStatus !== 'unknown' && editStatus !== 'error') return null;
  const parts = value.parts;
  if (!workState(parts.text) || !workState(parts.media) || !workState(parts.comments)
    || !workState(parts.replies) || !workState(parts.comment_media)) return null;
  // 单次核验封闭枚举，同时收窄输出类型。
  const checkStatus = value.check_status;
  const work = value.work;
  if (checkStatus !== 'unchecked' && checkStatus !== 'checked' && checkStatus !== 'unchanged' && checkStatus !== 'failed'
    || work !== 'pending' && work !== 'running' && work !== 'complete') return null;
  return { id: value.id, active: value.active, checkStatus, work, revision: value.revision,
    lastCheckedAt: value.last_checked_at, lastSucceededAt: value.last_succeeded_at,
    observedVersion: observed.observed_version ?? null, syncedVersion: value.synced_version, editStatus,
    checkError: value.check_error, syncError: value.sync_error,
    parts: { text: parts.text, media: parts.media, comments: parts.comments, replies: parts.replies, comment_media: parts.comment_media } };
}
