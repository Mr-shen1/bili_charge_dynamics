import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CommentSort, DynamicReader } from '../data/contracts';
import { Identity, displayTime } from './DynamicContent';
import { useDiscussionRead } from './useDiscussionRead';
import { ReadNotice } from './ReadNotice';
import { FoldableText } from './FoldableText';
import { ReplySection } from './ReplySection';
import styles from './Dynamics.module.css';
import { useDiscussionVisit } from './DiscussionVisit';

export function CommentSection({ reader, dynamicId, initialTarget }: {
  reader: DynamicReader; dynamicId: string; initialTarget: 'top' | 'comments';
}) {
  return reader.discussions === 'not-archived'
    ? <UnarchivedComments initialTarget={initialTarget} />
    : <ArchivedComments reader={reader} dynamicId={dynamicId} initialTarget={initialTarget} />;
}
function UnarchivedComments({ initialTarget }: { initialTarget: 'top' | 'comments' }) {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (initialTarget === 'comments') root.current?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }, [initialTarget]);
  return <section ref={root} aria-label="评论区"><h2>评论区</h2>
    <p role="status">评论尚未归档；来源计数不代表本地已有评论。</p>
  </section>;
}
function ArchivedComments({ reader, dynamicId, initialTarget }: {
  reader: DynamicReader; dynamicId: string; initialTarget: 'top' | 'comments';
}) {
  const visit = useDiscussionVisit();
  const [sort, setSort] = useState<CommentSort>(visit.current.sort);
  const root = useRef<HTMLElement>(null);
  const commentEntryPending = useRef(initialTarget === 'comments');
  const locateCommentEntry = useCallback(() => {
    if (!commentEntryPending.current) return;
    commentEntryPending.current = false;
    root.current?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }, []);
  const selectSort = (target: CommentSort) => {
    if (target === sort) return;
    commentEntryPending.current = false;
    root.current?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
    visit.current = { sort: target, read: { status: 'loading', data: null }, expanded: {}, replies: {} };
    setSort(target);
  };
  return <section ref={root} aria-label="评论区">
    <h2>评论区</h2>
    <div role="group" aria-label="评论排序">
      <button type="button" className={styles.button} aria-pressed={sort === 'hot'} onClick={() => selectSort('hot')}>最热</button>
      <button type="button" className={styles.button} aria-pressed={sort === 'latest'} onClick={() => selectSort('latest')}>最新</button>
    </div>
    <CommentSortView key={sort} reader={reader} dynamicId={dynamicId} sort={sort} onSettled={locateCommentEntry} />
  </section>;
}

function CommentSortView({ reader, dynamicId, sort, onSettled }: {
  reader: DynamicReader; dynamicId: string; sort: CommentSort; onSettled(): void;
}) {
  const read = useCallback((cursor: string | null | undefined, signal: AbortSignal) =>
    reader.readComments({ dynamicId, sort, cursor, signal }), [reader, dynamicId, sort]);
  const visit = useDiscussionVisit();
  const initial = useRef(visit.current);
  const { state, load } = useDiscussionRead(read, initial.current.read);
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>(initial.current.expanded);
  useLayoutEffect(() => {
    visit.current = { ...visit.current, sort, read: state, expanded };
  }, [visit, sort, state, expanded]);
  const area = sort === 'hot' ? '最热评论' : '最新评论';
  useLayoutEffect(() => { if (state.status !== 'loading') onSettled(); }, [state.status, onSettled]);
  return <>
    {!state.data && <ReadNotice status={state.status} area={area} retry={load} />}
    {state.data?.items.length === 0 && <p role="status">暂无评论</p>}
    <ul className={styles.comments} aria-label="一级评论">
      {state.data?.items.map(comment => <li key={comment.id} className={styles.card} data-reading-id={`comment:${comment.id}`}>
        <Identity user={comment.author} />
        {comment.author.id === reader.creator.id && <span>UP主</span>}
        <time className={styles.time} dateTime={comment.publishedAt ?? undefined}>{displayTime(comment.publishedAt)}</time>
        <FoldableText text={comment.text.trim() ? comment.text : '暂无评论内容'} subject="评论"
          expanded={expanded[comment.id] ?? false}
          toggle={() => setExpanded(previous => ({ ...previous, [comment.id]: !previous[comment.id] }))} />
        <p className={styles.count}>点赞 {comment.likeCount ?? '—'}</p>
        <p className={styles.count}>回复 {comment.replyCount ?? '—'}</p>
        {comment.replyCount !== 0 && <ReplySection reader={reader} dynamicId={dynamicId} rootId={comment.id} />}
      </li>)}
    </ul>
    {state.data && state.data.items.length > 0 && (state.data.nextCursor === null
      ? <p role="status">评论已加载完毕</p>
      : <section aria-label="评论追加">
        {state.status !== 'success' && <ReadNotice status={state.status} area={`${area}追加`} retry={load} />}
        {(state.status === 'success' || state.status === 'loading') && <button className={styles.button}
          type="button" disabled={state.status === 'loading'} onClick={() => void load()}>加载更多评论</button>}
      </section>)}
  </>;
}
