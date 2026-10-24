import type { HistoryState } from 'vue-router';

// 应用自有的历史元数据。只保存可序列化的轻量标识，不放入响应式代理、内容或阅读快照。
export const previewStateKey = 'biliChargeDynamicsPreview';

export interface PreviewMarker {
  readonly sessionId: string;
  readonly previewId: string;
  readonly groupId: string;
  readonly index: number;
}

export interface MarkerRead {
  /** 历史记录中存在应用命名空间键（含形状损坏），需要判断是否清理。 */
  readonly present: boolean;
  /** 形状完整且通过基础字段校验的标记；是否仍属于当前会话由 validateMarker 判断。 */
  readonly marker: PreviewMarker | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readMarker(state: unknown): MarkerRead {
  if (!isRecord(state) || !(previewStateKey in state)) return { present: false, marker: null };
  const raw = state[previewStateKey];
  // null 是本应用写入的“清理标记”，不是残留，也不再触发清理。
  if (raw === null || raw === undefined) return { present: false, marker: null };
  if (!isRecord(raw)) return { present: true, marker: null };
  const { sessionId, previewId, groupId, index } = raw;
  if (typeof sessionId !== 'string' || typeof previewId !== 'string' || typeof groupId !== 'string'
    || typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return { present: true, marker: null };
  }
  return { present: true, marker: { sessionId, previewId, groupId, index } };
}

/**
 * 写入 router 的 state 数据：只带应用命名空间，Vue Router 自有的 back/current/forward/position 由它自己维护。
 * vue-router 的 HistoryState 类型只声明原始值，而浏览器 pushState 接受可结构化克隆的对象；
 * 嵌套标记因此在这里收窄，运行期仍是普通对象，不写入代理或内容。
 */
export function markerState(marker: PreviewMarker | null): HistoryState {
  return { [previewStateKey]: marker ?? null } as unknown as HistoryState;
}

export function validateMarker(
  marker: PreviewMarker | null,
  sessionId: string,
  resolveGroupSize: (groupId: string) => number | undefined,
): PreviewMarker | null {
  if (!marker || marker.sessionId !== sessionId) return null;
  const size = resolveGroupSize(marker.groupId);
  return size !== undefined && marker.index < size ? marker : null;
}
