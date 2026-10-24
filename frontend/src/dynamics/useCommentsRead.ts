import { onMounted, onUnmounted, shallowRef } from 'vue';
import type { CommentSort, DynamicReader } from '../data/contracts';
import type { CommentReadState } from '../app/snapshots';

/**
 * 单个排序视图的一级评论读取：cursor 只前进、同批不并发、失败保留原批（重试同一 cursor）。
 * 已恢复成功的访问快照不重复请求；上次未完成的读取在重新挂载时从原 cursor 继续。
 * 请求身份写在实例内，排序切换/访问结束（组件卸载）后旧回调一律失效。
 */
export function useCommentsRead(
  reader: DynamicReader,
  input: { dynamicId: string; sort: CommentSort },
  initial?: CommentReadState,
) {
  const state = shallowRef<CommentReadState>(initial ?? { data: null, status: 'loading' });
  let request: AbortController | null = null;
  let active = false;

  async function load(): Promise<void> {
    if (!active || request) return;
    const previous = state.value.data;
    // 逻辑结束的唯一判据：没有下一批 cursor；结束后不再发起越界读取。
    if (previous && previous.nextCursor === null) return;
    const controller = new AbortController();
    request = controller;
    state.value = { data: previous, status: 'loading' };
    try {
      const result = await reader.readComments({
        dynamicId: input.dynamicId, sort: input.sort, cursor: previous?.nextCursor, signal: controller.signal,
      });
      // 取消可能被传输层忽略：仍以本次排序视图与请求身份为准，丢弃迟到结果。
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
    // 已恢复成功/失败结果时等待用户显式重试；只有未开始或已取消的读取自动继续。
    if (!initial || initial.status === 'loading' || initial.status === 'cancelled') void load();
  });
  onUnmounted(() => {
    active = false;
    request?.abort();
    request = null;
  });

  return { state, load };
}
