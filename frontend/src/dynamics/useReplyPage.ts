import { onMounted, onUnmounted, shallowRef } from 'vue';
import type { ReadResult, ReplyBatch, ReplyLocationResult } from '../data/contracts';
import type { ReplyReadState } from '../app/snapshots';
import { reportReadError } from '../app/readError';
import { replyPageCount } from './replyPaging';

export interface ReplyPageState extends ReplyReadState {
  readonly page: number;
}

/**
 * 楼中楼页码读取：每次请求按当前归档实时读取，不缓存页面也不追加。
 * 显式重读同一页同样发真实请求；数据减少导致页码越界时改用最新总数读有效末页。
 * 提供 `locate` 时首个读取改为按目标身份定位，直接得到目标所在页（精确入口）；
 * 之后的翻页、重试与普通页码读取完全一样。
 * 旧请求被取消或替换后的成功/失败/完成回调一律不生效。
 */
export function useReplyPage(
  read: (page: number, signal: AbortSignal) => Promise<ReadResult<ReplyBatch>>,
  initialPage: number | null,
  locate?: (signal: AbortSignal) => Promise<ReplyLocationResult>,
) {
  const state = shallowRef<ReplyPageState>({ status: 'loading', data: null, page: initialPage ?? 1 });
  let requestedPage = initialPage ?? 1;
  let request: AbortController | null = null;
  let active = false;
  /** 最近一次请求是定位读取：失败重试要重发定位，而不是猜一个页码。 */
  let locating = false;

  async function loadPage(page: number): Promise<void> {
    if (!active || !Number.isSafeInteger(page) || page < 1) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    locating = false;
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

  /** 精确入口的首个读取：按目标身份取得所在页，不先读第 1 页也不渲染全部回复。 */
  async function readLocation(): Promise<void> {
    if (!active || !locate) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    locating = true;
    const previous = state.value;
    const valid = (): boolean => active && request === controller && !controller.signal.aborted;
    state.value = { ...previous, status: 'loading', reason: undefined };
    try {
      const result = await locate(controller.signal);
      if (!valid()) return;
      if (result.status === 'success') {
        // 页码由服务端按目标位置给出：直接采用，不再猜或重读整楼。
        locating = false;
        requestedPage = result.data.page;
        state.value = { status: 'success', data: result.data, page: result.data.page };
      } else if (result.status === 'not-found') {
        // 目标确实不存在：与暂时失败分开，不把楼层第一页当作定位结果。
        state.value = { ...previous, status: 'not-found', data: null };
      } else {
        state.value = { ...previous, status: result.status,
          ...(result.status === 'error' ? { reason: result.reason } : {}) };
      }
    } catch (error) {
      if (valid()) {
        reportReadError('回复定位', error);
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

  /** 失败重试沿用最近一次请求：定位失败重发定位，页码失败重读同一页。 */
  function retry(): void {
    if (locating) void readLocation();
    else void loadPage(requestedPage);
  }

  onMounted(() => {
    active = true;
    if (locate) void readLocation();
    else if (initialPage !== null) void loadPage(initialPage);
  });
  onUnmounted(() => {
    active = false;
    cancel();
  });

  return { state, loadPage, retry, cancel };
}
