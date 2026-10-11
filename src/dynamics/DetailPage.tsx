import { useCallback, useEffect } from 'react';
import { useParams } from 'react-router';
import { useAppNavigation } from '../app/Navigation';
import type { DynamicReader } from '../data/contracts';
import { DynamicContent } from './DynamicContent';
import styles from './Dynamics.module.css';

import { useInitialRead } from './useInitialRead';
import { ReadNotice } from './ReadNotice';
import { CommentSection } from './CommentSection';

export function DetailPage({ reader }: { reader: DynamicReader }) {
  const { dynamicId = '' } = useParams();
  const { pageEntryId, returnToList, detailTarget } = useAppNavigation();
  const load = useCallback((signal: AbortSignal) => reader.readDetail({ id: dynamicId, signal }), [reader, dynamicId]);
  const { state, retry } = useInitialRead(`${pageEntryId}:${dynamicId}`, load);

  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, [pageEntryId]);

  return <main tabIndex={-1} className={styles.page}>
    <button className={styles.button} type="button" onClick={returnToList}>返回列表</button>
    <h1>动态详情</h1>
    <ReadNotice status={state.status} area="动态详情" retry={retry} />
    {state.status === 'not-found' && <p role="status">动态不存在或不可用</p>}
    {state.status === 'success' && <>
      <article className={styles.card}><DynamicContent dynamic={state.data} /></article>
      <CommentSection key={`${pageEntryId}:${dynamicId}`} reader={reader} dynamicId={dynamicId} initialTarget={detailTarget} />
    </>}
  </main>;
}
