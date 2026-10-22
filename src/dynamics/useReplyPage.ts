import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadResult, ReplyBatch } from '../data/contracts';
import type { DiscussionReadState } from '../app/DetailSnapshot';
import { replyPageSize } from './ReplyPager';

interface ReplyPageState extends DiscussionReadState<ReplyBatch> {
  readonly page: number;
}

/** 页码读取不缓存、不追加；显式点击同一页也重新请求，旧请求不能覆盖新结果。 */
export function useReplyPage(
  read: (page: number, signal: AbortSignal) => Promise<ReadResult<ReplyBatch>>,
  initialPage: number | null = 1,
) {
  const firstPage = useRef(initialPage);
  const [state, setState] = useState<ReplyPageState>({ status: 'loading', data: null, page: initialPage ?? 1 });
  const current = useRef(state);
  const requestedPage = useRef(initialPage ?? 1);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const update = useCallback((next: ReplyPageState) => {
    current.current = next;
    setState(next);
  }, []);
  const loadPage = useCallback(async function loadPage(page: number): Promise<void> {
    if (!active.current || !Number.isSafeInteger(page) || page < 1) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    requestedPage.current = page;
    const previous = current.current;
    const valid = () => active.current && request.current === controller && !controller.signal.aborted;
    update({ ...previous, status: 'loading', reason: undefined });
    try {
      const result = await read(page, controller.signal);
      if (!valid()) return;
      if (result.status === 'success') {
        const total = result.data.count ?? result.data.localReplyCount ?? result.data.items.length;
        const lastPage = Math.max(1, Math.ceil(total / replyPageSize));
        // 数据减少后原页可能已不存在：用最新总数定位末页，再真实读取一次。
        if (page > lastPage) {
          request.current = null;
          await loadPage(lastPage);
          return;
        }
        update({ status: 'success', data: result.data, page });
      } else {
        update({ ...previous, status: result.status,
          reason: result.status === 'error' ? result.reason : undefined });
      }
    } catch {
      if (valid()) update({ ...previous, status: 'error', reason: undefined });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [read, update]);
  const cancel = useCallback(() => {
    request.current?.abort();
    request.current = null;
  }, []);
  useEffect(() => {
    active.current = true;
    if (firstPage.current !== null) void loadPage(firstPage.current);
    return () => {
      active.current = false;
      cancel();
    };
  }, [loadPage, cancel]);
  const retry = useCallback(() => loadPage(requestedPage.current), [loadPage]);
  return { state, loadPage, retry, cancel };
}
