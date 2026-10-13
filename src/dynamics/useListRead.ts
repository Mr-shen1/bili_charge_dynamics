import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchiveScope, DynamicReader } from '../data/contracts';
import type { ListReadState } from '../app/ListSnapshot';

export function useListRead(reader: DynamicReader, scope: ArchiveScope, initial?: ListReadState) {
  const [state, setState] = useState<ListReadState>(initial ?? { data: null, status: 'loading' });
  const current = useRef(state);
  const request = useRef<AbortController | null>(null);
  const active = useRef(false);
  const update = useCallback((next: ListReadState) => {
    current.current = next;
    setState(next);
  }, []);
  const load = useCallback(async (restart = false) => {
    if (!active.current || request.current) return;
    const previous = restart ? null : current.current.data;
    if (previous?.nextCursor === null) return;
    const controller = new AbortController();
    request.current = controller;
    update({ data: previous, status: 'loading' });
    try {
      const result = await reader.readList({ scope, limit: 10, cursor: previous?.nextCursor, signal: controller.signal });
      if (!active.current || request.current !== controller || controller.signal.aborted) return;
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
      } else update({ data: previous, status: result.status, reason: result.status === 'error' ? result.reason : undefined });
    } catch {
      if (active.current && request.current === controller && !controller.signal.aborted) {
        update({ data: previous, status: 'error' });
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [reader, scope, update]);
  useEffect(() => {
    active.current = true;
    if (!current.current.data || current.current.status === 'loading' || current.current.status === 'cancelled') void load();
    return () => {
      active.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  return { state, load };
}
