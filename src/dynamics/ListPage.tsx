import { useLayoutEffect, useRef, useState } from 'react';
import type { DynamicReader } from '../data/contracts';
import { DynamicContent, Identity } from './DynamicContent';
import { useAppNavigation } from '../app/Navigation';
import { captureReadingPosition, restoreReadingPosition } from '../app/readingPosition';
import styles from './Dynamics.module.css';

import { useListRead } from './useListRead';
import { ReadNotice } from './ReadNotice';

export function ListPage({ reader }: { reader: DynamicReader }) {
  const { pageEntryId } = useAppNavigation();
  return <ListVisit key={pageEntryId} reader={reader} />;
}

function ListVisit({ reader }: { reader: DynamicReader }) {
  const { pageEntryId, openDetail, listSnapshot, saveListSnapshot } = useAppNavigation();
  const { state, load } = useListRead(reader, listSnapshot?.read);
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

  return <main ref={root} className={styles.page}>
    <header className={styles.header}>
      <Identity user={reader.creator} heading />
    </header>
    {!state.data && <ReadNotice status={state.status} area="动态列表" retry={load} />}
    {state.data?.items.length === 0 && <p role="status">暂无动态</p>}
    {state.data?.items.map(dynamic => <article className={styles.card} key={dynamic.id} data-reading-id={dynamic.id}>
      <DynamicContent dynamic={dynamic} folding={{ expanded: expanded[dynamic.id] ?? false,
        toggle: () => setExpanded(previous => ({ ...previous, [dynamic.id]: !previous[dynamic.id] })),
      }} />
      <button className={styles.button} type="button" onClick={() => openDetail(dynamic.id)}>查看详情</button>
    </article>)}
    {state.data && state.data.items.length > 0 && (state.data.nextCursor === null
      ? <p role="status">动态已加载完毕</p>
      : <section aria-label="动态追加">
        {state.status !== 'success' && <ReadNotice status={state.status} area="动态追加" retry={load} />}
        {(state.status === 'success' || state.status === 'loading') && <button className={styles.button}
          type="button" disabled={state.status === 'loading'} onClick={() => void load()}>加载更多</button>}
      </section>)}
  </main>;
}
