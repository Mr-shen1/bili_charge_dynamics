import type { HistoryState } from 'vue-router';
import { isRecord } from '../data/guards';

/**
 * 应用自有的历史元数据：只保存会话、页面访问与预览标识，
 * 不写入响应式代理、完整内容或阅读快照。Vue Router 自有的 back/current/forward/position 保持原样。
 */
export const entryStateKey = 'biliChargeDynamicsEntry';
export const previewStateKey = 'biliChargeDynamicsPreview';

/** 一条浏览器历史记录对应一次页面访问；不以动态 ID 或路径作为快照身份。 */
export interface EntryMarker {
  readonly sessionId: string;
  readonly pageEntryId: string;
}

export interface PreviewMarker {
  readonly sessionId: string;
  readonly previewId: string;
  readonly groupId: string;
  readonly index: number;
}

export interface MarkerRead<T> {
  /** 历史记录中存在应用命名空间键（含形状损坏），需要判断是否清理。 */
  readonly present: boolean;
  /** 形状完整且通过基础字段校验的标记；是否仍属于当前会话由调用方判断。 */
  readonly marker: T | null;
}

function readNamespace<T>(
  state: unknown,
  key: string,
  validate: (raw: Record<string, unknown>) => T | null,
): MarkerRead<T> {
  if (!isRecord(state) || !(key in state)) return { present: false, marker: null };
  const raw = state[key];
  // null 是本应用写入的“清理标记”，不是残留，也不再触发清理。
  if (raw === null || raw === undefined) return { present: false, marker: null };
  if (!isRecord(raw)) return { present: true, marker: null };
  const marker = validate(raw);
  return { present: true, marker };
}

export function readEntryMarker(state: unknown): MarkerRead<EntryMarker> {
  return readNamespace(state, entryStateKey, raw =>
    typeof raw.sessionId === 'string' && typeof raw.pageEntryId === 'string'
      ? { sessionId: raw.sessionId, pageEntryId: raw.pageEntryId }
      : null);
}

export function readPreviewMarker(state: unknown): MarkerRead<PreviewMarker> {
  return readNamespace(state, previewStateKey, raw => {
    const { sessionId, previewId, groupId, index } = raw;
    if (typeof sessionId !== 'string' || typeof previewId !== 'string' || typeof groupId !== 'string'
      || typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return null;
    }
    return { sessionId, previewId, groupId, index };
  });
}

export interface AppHistoryState {
  readonly entry: EntryMarker | null;
  readonly preview: PreviewMarker | null;
}

/**
 * 两个应用命名空间必须一起写入：预览记录与页面访问共用一条历史记录，
 * 只写自己那份会把另一份清掉。Vue Router 的 push/replace 不合并上一条记录的 state，
 * 因此调用方显式给出当前值，而不是依赖浏览器残留。
 */
export function appHistoryState(state: AppHistoryState): HistoryState {
  return {
    [entryStateKey]: state.entry,
    [previewStateKey]: state.preview,
  } as unknown as HistoryState;
}
