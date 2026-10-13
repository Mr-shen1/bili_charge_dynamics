import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ArchiveNavigation } from './ArchiveNavigation';
import type { ArchiveScope, DynamicReader } from '../data/contracts';
import { DynamicContent } from './DynamicContent';
import { DynamicCard } from './DynamicCard';
import { useAppNavigation } from '../app/Navigation';
import { captureReadingPosition, restoreReadingPosition } from '../app/readingPosition';
import styles from './Dynamics.module.css';

import { useListRead } from './useListRead';
import { ReadNotice } from './ReadNotice';

export function ListPage({ reader }: { reader: DynamicReader }) {
  const { pageEntryId } = useAppNavigation();
  const { upId } = useParams();
  const scope = useMemo<ArchiveScope>(() => upId === undefined ? { kind: 'all' } : { kind: 'up', upId }, [upId]);
  return <ListVisit key={`${pageEntryId}:${upId ?? 'all'}`} reader={reader} scope={scope} />;
}

function ListVisit({ reader, scope }: { reader: DynamicReader; scope: ArchiveScope }) {
  const { pageEntryId, openDetail, listSnapshot, saveListSnapshot } = useAppNavigation();
  const { state, load } = useListRead(reader, scope, listSnapshot?.read);
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>(listSnapshot?.expanded ?? {});
  const root = useRef<HTMLElement>(null);
  const initialPosition = useRef(listSnapshot?.position ?? null);
  const latest = useRef({ state, expanded });
  useLayoutEffect(() => { latest.current = { state, expanded }; }, [state, expanded]);
  useLayoutEffect(() => {
    const element = root.current;
    const stopRestoring = restoreReadingPosition(element, initialPosition.current);
    return () => {
      stopRestoring();
      const { state: read, expanded } = latest.current;
      saveListSnapshot(pageEntryId, {
        read: read.status === 'loading' ? { ...read, status: 'cancelled' } : read,
        expanded, position: captureReadingPosition(element),
      });
    };
  }, [pageEntryId, saveListSnapshot]);

  return <main ref={root} tabIndex={-1} className={styles.page}>
    <header className={styles.header}>
      <h1>{scope.kind === 'all' ? '全部动态' : `UP ${scope.upId} 归档`}</h1>
      <ArchiveNavigation reader={reader} scope={scope} />
    </header>
    {state.reason === 'invalid-cursor' && <section>
      <p role="alert">分页已失效，请重新开始读取。</p>
      <button className={styles.button} type="button" onClick={() => void load(true)}>重新开始</button>
    </section>}
    {state.reason === 'unknown-up' ? <p role="status">UP 不存在</p>
      : !state.data && state.reason !== 'invalid-cursor' && <ReadNotice status={state.status} area="动态列表" retry={() => void load()} />}
    {state.data?.items.length === 0 && <p role="status">暂无动态</p>}
    {state.data?.items.map(dynamic => <DynamicCard key={dynamic.id} id={dynamic.id}>
      <DynamicContent dynamic={dynamic} navigateToComments={() => openDetail(dynamic.id, 'comments')} folding={{ expanded: expanded[dynamic.id] ?? false,
        toggle: () => setExpanded(previous => ({ ...previous, [dynamic.id]: !previous[dynamic.id] })),
      }} />
    </DynamicCard>)}
    {state.data && state.data.items.length > 0 && (state.data.nextCursor === null
      ? <p role="status">动态已加载完毕</p>
      : <section aria-label="动态追加">
        {state.status !== 'success' && state.reason !== 'invalid-cursor' && <ReadNotice status={state.status} area="动态追加" retry={() => void load()} />}
        {(state.status === 'success' || state.status === 'loading') && <button className={styles.button}
          type="button" disabled={state.status === 'loading'} onClick={() => void load()}>加载更多</button>}
      </section>)}
  </main>;
}
