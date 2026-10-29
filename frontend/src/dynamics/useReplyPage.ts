import { onMounted, onUnmounted, shallowRef } from 'vue';
import type { LocateStatus, ReadResult, ReplyBatch, ReplyLocation } from '../data/contracts';
import { reportReadError } from '../app/readError';
import { replyPageCount } from './replyPaging';

/** 页码读取只关心条目、总数与可选本地数；对话页与本楼回复页共用同一套状态机。 */
export interface ReplyPageData {
  readonly items: readonly unknown[];
  readonly count?: number;
  readonly localReplyCount?: number | null;
}

/** 身份不存在（对话或楼中楼目标）与暂时失败分开，由调用方决定提示与返回入口。 */
export type ReplyPageReadResult<Batch> = ReadResult<Batch> | { readonly status: 'not-found' };

export interface ReplyPageState<Batch = ReplyBatch> {
  readonly data: Batch | null;
  readonly reason?: Extract<ReadResult<Batch>, { status: 'error' }>['reason'];
  readonly status: LocateStatus;
  readonly page: number;
}

/**
 * 楼中楼页码读取：每次请求按当前归档实时读取，不缓存页面也不追加。
 * 显式重读同一页同样发真实请求；数据减少导致页码越界时改用最新总数读有效末页。
 * 提供 `locate` 时首个读取改为按目标身份定位，直接得到目标所在页（精确入口）；
 * 之后的翻页、重试与普通页码读取完全一样。
 * 提供 `restored` 时先按快照的页码与内容呈现（会话返回、历史恢复），不先显示第 1 页；
 * 只有上次没读完（加载中/已取消）的读取才补读：定位访问重发定位（页码本来未知），
 * 普通访问补读同一页；失败时保留快照内容。恢复的定位访问若上次没定位成功，
 * 重试也重发定位，不拿第 1 页冒充定位结果。
 * `loadPage(page, {clear:true})` 用于切换排序：先丢掉上一排序的条目、页码与计数，
 * 目标排序自己失败也停在空底，不让旧排序的数据冒充新选择。
 * 旧请求被取消或替换后的成功/失败/完成回调一律不生效。
 */
export function useReplyPage<Batch extends ReplyPageData = ReplyBatch>(
  read: (page: number, signal: AbortSignal) => Promise<ReplyPageReadResult<Batch>>,
  initialPage: number | null,
  locate?: (signal: AbortSignal) => Promise<ReplyPageReadResult<Batch & ReplyLocation>>,
  restored?: ReplyPageState<Batch> | null,
) {
  const state = shallowRef<ReplyPageState<Batch>>(
    restored ?? { status: 'loading', data: null, page: initialPage ?? 1 });
  let requestedPage = restored?.page ?? initialPage ?? 1;
  let request: AbortController | null = null;
  let active = false;
  /**
   * 最近一次请求是定位读取：失败重试要重发定位，而不是猜一个页码。
   * 恢复的定位访问若上次没成功，重试同样重发定位。
   */
  let locating = Boolean(restored && locate && restored.status !== 'success');

  async function loadPage(page: number, options: { readonly clear?: boolean } = {}): Promise<void> {
    if (!active || !Number.isSafeInteger(page) || page < 1) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    locating = false;
    requestedPage = page;
    const previous = state.value;
    // 切换排序时清空上一排序的内容：旧排序的条目、页码与计数不得在新标签下继续存在；
    // 目标排序自己失败时也回到这份空底，不拿旧排序的页冒充新选择。
    const base: ReplyPageState<Batch> = options.clear
      ? { status: 'loading', data: null, page }
      : previous;
    const valid = (): boolean => active && request === controller && !controller.signal.aborted;
    state.value = { ...base, status: 'loading', reason: undefined };
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
      } else if (result.status === 'not-found') {
        // 身份不存在（如对话目标已被删除）：清空过期内容，与暂时失败分开。
        state.value = { ...base, status: 'not-found', data: null };
      } else {
        state.value = { ...base, status: result.status,
          ...(result.status === 'error' ? { reason: result.reason } : {}) };
      }
    } catch (error) {
      if (valid()) {
        reportReadError('回复页码', error);
        state.value = { ...base, status: 'error' };
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
    if (restored) {
      // 已完成的读取直接沿用快照内容；上次没读完的才补读，失败也保留快照内容。
      if (restored.status === 'loading' || restored.status === 'cancelled') {
        if (locate) void readLocation();
        else void loadPage(restored.page);
      }
      return;
    }
    if (locate) void readLocation();
    else if (initialPage !== null) void loadPage(initialPage);
  });
  onUnmounted(() => {
    active = false;
    cancel();
  });

  return { state, loadPage, retry, cancel };
}
