import { onMounted, onUnmounted, shallowRef } from 'vue';
import type { DetailResult, Dynamic, DynamicReader } from '../data/contracts';

export interface DetailReadState {
  readonly status: 'loading' | 'success' | 'error' | 'cancelled' | 'not-found';
  readonly data: Dynamic | null;
}

/**
 * 详情读取：历史恢复已有成功内容时直接复用，不重复请求；
 * 只有显式重试才会重读。请求身份属于本次访问，离开后旧回调一律失效。
 */
export function useDetailRead(reader: DynamicReader, dynamicId: string, cached: Dynamic | null) {
  const state = shallowRef<DetailReadState>(
    cached ? { status: 'success', data: cached } : { status: 'loading', data: null });
  let request: AbortController | null = null;
  let active = false;

  async function read(): Promise<void> {
    if (!active || request) return;
    const controller = new AbortController();
    request = controller;
    state.value = { status: 'loading', data: null };
    try {
      const result: DetailResult = await reader.readDetail({ id: dynamicId, signal: controller.signal });
      // 取消可能被传输层忽略：仍以本次访问与请求身份为准，丢弃迟到结果。
      if (!active || request !== controller || controller.signal.aborted) return;
      state.value = result.status === 'success'
        ? { status: 'success', data: result.data }
        : { status: result.status, data: null };
    } catch {
      if (active && request === controller && !controller.signal.aborted) {
        state.value = { status: 'error', data: null };
      }
    } finally {
      if (request === controller) request = null;
    }
  }

  onMounted(() => {
    active = true;
    if (!cached) void read();
  });
  onUnmounted(() => {
    active = false;
    request?.abort();
    request = null;
  });

  return { state, retry: () => { void read(); } };
}
