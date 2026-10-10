import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommentBatch, CommentSort, DynamicReader, ReadResult } from '../data/contracts';

interface CommentReadState {
  readonly status: ReadResult<CommentBatch>['status'] | 'loading';
  readonly data: CommentBatch | null;
}

// 每个评论排序视图独立拥有批次和请求；切换排序/访问时卸载，不能复用旧分页。
export function useCommentRead(reader: DynamicReader, dynamicId: string, sort: CommentSort) {
  const [state, setState] = useState<CommentReadState>({ status: 'loading', data: null });
  const current = useRef(state);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const update = useCallback((next: CommentReadState) => {
    current.current = next;
    setState(next);
  }, []);
  const load = useCallback(async () => {
    if (!active.current || request.current) return;
    const previous = current.current.data;
    if (previous?.nextCursor === null) return;
    const controller = new AbortController();
    request.current = controller;
    const valid = () => active.current && request.current === controller && !controller.signal.aborted;
    update({ data: previous, status: 'loading' });
    try {
      const result = await reader.readComments({ dynamicId, sort, cursor: previous?.nextCursor, signal: controller.signal });
      if (!valid()) return;
      if (result.status === 'success') {
        const seen = new Set(previous?.items.map(item => item.id));
        const additions = result.data.items.filter(item => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        });
        update({ status: 'success', data: {
          items: [...(previous?.items ?? []), ...additions], nextCursor: result.data.nextCursor,
        } });
      } else update({ data: previous, status: result.status });
    } catch {
      if (valid()) update({ data: previous, status: 'error' });
    } finally {
      if (valid()) request.current = null;
    }
  }, [reader, dynamicId, sort, update]);
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  return { state, load };
}
