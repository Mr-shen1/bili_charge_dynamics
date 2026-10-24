import { onMounted, onUnmounted, shallowRef } from 'vue';
import type { ReadResult, ReplyBatch } from '../data/contracts';
import type { ReplyReadState } from '../app/snapshots';
import { reportReadError } from '../app/readError';
import { replyPageCount } from './replyPaging';

export interface ReplyPageState extends ReplyReadState {
  readonly page: number;
}

/**
 * 楼中楼页码读取：每次请求按当前归档实时读取，不缓存页面也不追加。
 * 显式重读同一页同样发真实请求；数据减少导致页码越界时改用最新总数读有效末页。
 * 旧请求被取消或替换后的成功/失败/完成回调一律不生效。
 */
export function useReplyPage(
  read: (page: number, signal: AbortSignal) => Promise<ReadResult<ReplyBatch>>,
  initialPage: number | null,
) {
  const state = shallowRef<ReplyPageState>({ status: 'loading', data: null, page: initialPage ?? 1 });
  let requestedPage = initialPage ?? 1;
  let request: AbortController | null = null;
  let active = false;

  async function loadPage(page: number): Promise<void> {
    if (!active || !Number.isSafeInteger(page) || page < 1) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    requestedPage = page;
    const previous = state.value;
    const valid = (): boolean => active && request === controller && !controller.signal.aborted;
    state.value = { ...previous, status: 'loading', reason: undefined };
    try {
      const result = await read(page, controller.signal);
      if (!valid()) return;
      if (result.status === 'success') {
        const total = result.data.count ?? result.data.localReplyCount ?? result.data.items.length;
        const lastPage = replyPageCount(total, result.data.items.length);
        // 回复减少后原页可能已不存在：用最新总数定位末页，再真实读取一次。
        if (page > lastPage) {
          request = null;
          await loadPage(lastPage);
          return;
        }
        state.value = { status: 'success', data: result.data, page };
      } else {
        state.value = { ...previous, status: result.status,
          ...(result.status === 'error' ? { reason: result.reason } : {}) };
      }
    } catch (error) {
      if (valid()) {
        reportReadError('回复页码', error);
        state.value = { ...previous, status: 'error' };
      }
    } finally {
      if (request === controller) request = null;
    }
  }

  /** 收起或卸载时取消在途页码请求；取消后迟到的回调不再改动状态。 */
  function cancel(): void {
    request?.abort();
    request = null;
  }

  /** 失败重试沿用最近一次请求的页码，同样发真实请求。 */
  function retry(): void {
    void loadPage(requestedPage);
  }

  onMounted(() => {
    active = true;
    if (initialPage !== null) void loadPage(initialPage);
  });
  onUnmounted(() => {
    active = false;
    cancel();
  });

  return { state, loadPage, retry, cancel };
}
