import { onMounted, onUnmounted, shallowRef } from 'vue';
import type { CommentSort, DynamicReader } from '../data/contracts';
import type { CommentReadState } from '../app/snapshots';
import { reportReadError } from '../app/readError';

/**
 * 单个排序视图的一级评论读取：cursor 只前进、同批不并发、失败保留原批（重试同一 cursor）。
 * 有锚点时首批改走定位读取：只取含目标的那一批，不先加载首批也不渲染全部评论。
 * 已恢复成功的访问快照不重复请求；上次未完成的读取在重新挂载时从原 cursor 继续。
 * 请求身份写在实例内，排序切换/访问结束（组件卸载）后旧回调一律失效。
 */
export function useCommentsRead(
  reader: DynamicReader,
  input: { dynamicId: string; sort: CommentSort; anchorId?: string | null },
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
      // 只有首批（还没有 cursor）且声明了锚点时才走定位读取；续读始终回到普通分页。
      const result = !previous && input.anchorId
        ? await reader.locateComment({
          dynamicId: input.dynamicId, rootId: input.anchorId, sort: input.sort, signal: controller.signal,
        })
        : await reader.readComments({
          dynamicId: input.dynamicId, sort: input.sort, cursor: previous?.nextCursor, signal: controller.signal,
        });
      // 取消可能被传输层忽略：仍以本次排序视图与请求身份为准，丢弃迟到结果。
      if (!active || request !== controller || controller.signal.aborted) return;
      if (result.status === 'not-found') {
        state.value = { data: null, status: 'not-found' };
      } else if (result.status === 'success') {
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
    } catch (error) {
      if (active && request === controller && !controller.signal.aborted) {
        reportReadError('一级评论', error);
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
