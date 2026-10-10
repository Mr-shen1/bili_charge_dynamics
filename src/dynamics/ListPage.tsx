import { useCallback } from 'react';
import type { DynamicReader } from '../data/contracts';
import { DynamicContent, Identity } from './DynamicContent';
import { useAppNavigation } from '../app/Navigation';
import styles from './Dynamics.module.css';

import { useInitialRead } from './useInitialRead';
import { ReadNotice } from './ReadNotice';

export function ListPage({ reader }: { reader: DynamicReader }) {
  const { pageEntryId, openDetail } = useAppNavigation();
  const load = useCallback((signal: AbortSignal) => reader.readList({ limit: 10, signal }), [reader]);
  const { state, retry } = useInitialRead(pageEntryId, load);

  return <main className={styles.page}>
    <header className={styles.header}>
      <Identity user={reader.creator} heading />
    </header>
    <ReadNotice status={state.status} area="动态列表" retry={retry} />
    {state.status === 'success' && state.data.items.length === 0 && <p role="status">暂无动态</p>}
    {state.status === 'success' && state.data.items.map(dynamic => <article className={styles.card} key={dynamic.id}>
      <DynamicContent dynamic={dynamic} />
      <button className={styles.button} type="button" onClick={() => openDetail(dynamic.id)}>查看详情</button>
    </article>)}
  </main>;
}
