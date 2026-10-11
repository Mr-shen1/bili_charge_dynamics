import { useCallback, useLayoutEffect, useRef } from 'react';
import { useParams } from 'react-router';
import { useAppNavigation } from '../app/Navigation';
import type { DetailResult, DynamicReader } from '../data/contracts';
import { DynamicContent } from './DynamicContent';
import styles from './Dynamics.module.css';

import { useInitialRead } from './useInitialRead';
import { ReadNotice } from './ReadNotice';
import { CommentSection } from './CommentSection';
import { DiscussionVisitContext } from './DiscussionVisit';
import type { CommentSnapshot } from '../app/DetailSnapshot';
import { captureReadingPosition, restoreReadingPosition } from '../app/readingPosition';

export function DetailPage({ reader }: { reader: DynamicReader }) {
  const { pageEntryId } = useAppNavigation();
  return <DetailVisit key={pageEntryId} reader={reader} />;
}

function DetailVisit({ reader }: { reader: DynamicReader }) {
  const { dynamicId = '' } = useParams();
  const { pageEntryId, returnToList, detailTarget, detailSnapshot, saveDetailSnapshot } = useAppNavigation();
  const discussion = useRef<CommentSnapshot>(detailSnapshot?.comments ?? {
    sort: 'hot', read: { status: 'loading', data: null }, expanded: {}, replies: {},
  });
  const root = useRef<HTMLElement>(null);
  const initial = useRef(detailSnapshot);
  const cached = useRef<DetailResult | undefined>(detailSnapshot?.dynamic
    ? { status: 'success', data: detailSnapshot.dynamic } : undefined);
  const load = useCallback((signal: AbortSignal) => reader.readDetail({ id: dynamicId, signal }), [reader, dynamicId]);
  const { state, retry } = useInitialRead(`${pageEntryId}:${dynamicId}`, load, cached.current);
  const content = useRef(detailSnapshot?.dynamic ?? null);
  useLayoutEffect(() => { if (state.status === 'success') content.current = state.data; }, [state]);
  useLayoutEffect(() => {
    const element = root.current;
    const stopRestoring = restoreReadingPosition(element, initial.current?.position ?? null);
    return () => {
      stopRestoring();
      saveDetailSnapshot(pageEntryId, { dynamic: content.current, comments: discussion.current,
        position: captureReadingPosition(element),
      });
    };
  }, [pageEntryId, saveDetailSnapshot]);

  return <main ref={root} tabIndex={-1} className={styles.page}>
    <button className={styles.button} type="button" onClick={returnToList}>返回列表</button>
    <h1>动态详情</h1>
    <ReadNotice status={state.status} area="动态详情" retry={retry} />
    {state.status === 'not-found' && <p role="status">动态不存在或不可用</p>}
    {state.status === 'success' && <>
      <article className={styles.card} data-reading-id={`dynamic:${dynamicId}`}><DynamicContent dynamic={state.data} /></article>
      <DiscussionVisitContext.Provider value={discussion}>
        {/* 只用挂载时的快照判断入口，StrictMode 清理生成的草稿不能改写主动意图。 */}
        <CommentSection reader={reader} dynamicId={dynamicId} initialTarget={initial.current ? 'top' : detailTarget} />
      </DiscussionVisitContext.Provider>
    </>}
  </main>;
}
