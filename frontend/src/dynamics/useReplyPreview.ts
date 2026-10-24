import { onMounted, onUnmounted, shallowRef } from 'vue';
import { replyPreviewSize } from '../data/contracts';
import type { DynamicReader } from '../data/contracts';
import type { ReplyReadState } from '../app/snapshots';
import { reportReadError } from '../app/readError';

/**
 * 宽屏回复预览：cursor 模式首批最多 3 条，只读这一批，不做累计追加。
 * 失败保留原结果并沿用同一请求重试；展开后的页码读取由 `useReplyPage` 单独承担。
 * 请求身份写在实例内：回复区卸载或收起后，迟到结果一律失效。
 */
export function useReplyPreview(
  reader: DynamicReader,
  input: { dynamicId: string; rootId: string },
  initial?: ReplyReadState,
) {
  const state = shallowRef<ReplyReadState>(initial ?? { data: null, status: 'loading' });
  let request: AbortController | null = null;
  let active = false;

  async function load(): Promise<void> {
    if (!active || request) return;
    const previous = state.value.data;
    // 预览只有首批；已有内容时展开走页码模式，不再追加 cursor。
    if (previous !== null) return;
    const controller = new AbortController();
    request = controller;
    state.value = { data: previous, status: 'loading' };
    try {
      const result = await reader.readReplies({
        dynamicId: input.dynamicId, rootId: input.rootId, limit: replyPreviewSize, signal: controller.signal,
      });
      // 取消可能被传输层忽略：仍以本次请求身份为准，丢弃迟到结果。
      if (!active || request !== controller || controller.signal.aborted) return;
      state.value = result.status === 'success'
        ? { status: 'success', data: result.data }
        : { data: previous, status: result.status,
          ...(result.status === 'error' ? { reason: result.reason } : {}) };
    } catch (error) {
      if (active && request === controller && !controller.signal.aborted) {
        reportReadError('回复预览', error);
        state.value = { data: previous, status: 'error' };
      }
    } finally {
      if (request === controller) request = null;
    }
  }

  function cancel(): void {
    request?.abort();
    request = null;
  }

  /** 失效 cursor 后重来：丢弃预览结果重新读首批。 */
  function restart(): void {
    if (!active) return;
    cancel();
    state.value = { data: null, status: 'loading' };
    void load();
  }

  onMounted(() => {
    active = true;
    // 已恢复成功/失败结果时等待用户显式重试；只有未开始或已取消的读取自动继续。
    if (!initial || initial.status === 'loading' || initial.status === 'cancelled') void load();
  });
  onUnmounted(() => {
    active = false;
    cancel();
  });

  return { state, load, restart };
}
