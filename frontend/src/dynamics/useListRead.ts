import { onMounted, onUnmounted, shallowRef } from 'vue';
import type { ArchiveScope, DynamicReader } from '../data/contracts';
import type { ListReadState } from '../app/snapshots';

/**
 * 单个 scope 访问的列表读取：cursor 只前进、同批不并发、失败保留原批。
 * 已有的访问快照直接复用已加载批次；上次未完成的读取在重新挂载时从原 cursor 继续。
 * 请求身份写在实例内，访问结束（组件卸载/scope 重建）后旧回调一律失效。
 */
export function useListRead(reader: DynamicReader, scope: ArchiveScope, initial?: ListReadState) {
  const state = shallowRef<ListReadState>(initial ?? { data: null, status: 'loading' });
  let request: AbortController | null = null;
  let active = false;

  async function load(restart = false): Promise<void> {
    if (!active || request) return;
    const previous = restart ? null : state.value.data;
    if (previous && previous.nextCursor === null) return;
    const controller = new AbortController();
    request = controller;
    state.value = { data: previous, status: 'loading' };
    try {
      const result = await reader.readList({
        scope, limit: 10, cursor: previous?.nextCursor, signal: controller.signal,
      });
      // 取消可能被传输层忽略：仍以本次访问与请求身份为准，丢弃迟到结果。
      if (!active || request !== controller || controller.signal.aborted) return;
      if (result.status === 'success') {
        const seen = new Set(previous?.items.map(item => item.id));
        const additions = result.data.items.filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
        state.value = {
          status: 'success',
          data: { items: [...(previous?.items ?? []), ...additions], nextCursor: result.data.nextCursor },
        };
      } else {
        state.value = {
          data: previous,
          status: result.status,
          ...(result.status === 'error' ? { reason: result.reason } : {}),
        };
      }
    } catch {
      if (active && request === controller && !controller.signal.aborted) {
        state.value = { data: previous, status: 'error' };
      }
    } finally {
      if (request === controller) request = null;
    }
  }

  onMounted(() => {
    active = true;
    const current = state.value;
    // 已加载批次且上次读取已结束：直接复用访问快照，不重复请求。
    if (!current.data || current.status === 'loading' || current.status === 'cancelled') void load();
  });
  onUnmounted(() => {
    active = false;
    request?.abort();
    request = null;
  });

  return { state, load };
}
