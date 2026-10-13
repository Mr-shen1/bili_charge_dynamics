import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { emptyCommentSnapshot } from '../app/DetailSnapshot';
import type { ArchiveMetadata, CommentSort, DynamicReader } from '../data/contracts';
import { Identity, displayTime } from './DynamicContent';
import { useDiscussionRead } from './useDiscussionRead';
import { ReadNotice } from './ReadNotice';
import { FoldableText } from './FoldableText';
import { ReplySection } from './ReplySection';
import styles from './Dynamics.module.css';
import { useDiscussionVisit } from './DiscussionVisit';

const unarchivedMessage = '评论尚未归档；来源计数不代表本地已有评论。';

export function locateComments(root: HTMLElement | null) {
  root?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
}

export function CommentSection({ reader, dynamicId, authorId, initialTarget, canLocateEntry, archive, rootRef }: {
  reader: DynamicReader; dynamicId: string; authorId: string; initialTarget: 'top' | 'comments'; canLocateEntry(): boolean; archive?: ArchiveMetadata; rootRef: RefObject<HTMLElement | null>;
}) {
  return reader.discussions === 'not-archived'
    ? <UnarchivedComments initialTarget={initialTarget} canLocateEntry={canLocateEntry} root={rootRef} />
    : <ArchivedComments reader={reader} dynamicId={dynamicId} authorId={authorId} initialTarget={initialTarget} canLocateEntry={canLocateEntry} root={rootRef}
      emptyUnarchived={Boolean(archive && (archive.rootCommentsLastAttempt ?? archive.work.comments) !== 'success')} />;
}
function UnarchivedComments({ initialTarget, canLocateEntry, root }: { initialTarget: 'top' | 'comments'; canLocateEntry(): boolean; root: RefObject<HTMLElement | null> }) {
  useLayoutEffect(() => {
    if (initialTarget === 'comments' && canLocateEntry()) locateComments(root.current);
  }, [initialTarget, canLocateEntry]);
  return <section ref={root} aria-label="评论区"><h2>评论区</h2>
    <p role="status">{unarchivedMessage}</p>
  </section>;
}
function ArchivedComments({ reader, dynamicId, authorId, initialTarget, canLocateEntry, emptyUnarchived, root }: {
  reader: DynamicReader; dynamicId: string; authorId: string; initialTarget: 'top' | 'comments'; canLocateEntry(): boolean; emptyUnarchived: boolean; root: RefObject<HTMLElement | null>;
}) {
  const visit = useDiscussionVisit();
  const [sort, setSort] = useState<CommentSort>(visit.current.sort);
  const [restartKey, setRestartKey] = useState(0);
  const commentEntryPending = useRef(initialTarget === 'comments');
  const locateCommentEntry = useCallback(() => {
    if (!commentEntryPending.current) return;
    commentEntryPending.current = false;
    if (canLocateEntry()) locateComments(root.current);
  }, [canLocateEntry]);
  const selectSort = (target: CommentSort) => {
    if (target === sort) return;
    commentEntryPending.current = false;
    locateComments(root.current);
    visit.current = emptyCommentSnapshot(target);
    setSort(target);
  };
  return <section ref={root} aria-label="评论区">
    <h2>评论区</h2>
    <div role="group" aria-label="评论排序">
      <button type="button" className={styles.button} aria-pressed={sort === 'hot'} onClick={() => selectSort('hot')}>最热</button>
      <button type="button" className={styles.button} aria-pressed={sort === 'latest'} onClick={() => selectSort('latest')}>最新</button>
    </div>
    <CommentSortView key={`${sort}:${restartKey}`} reader={reader} dynamicId={dynamicId} authorId={authorId} sort={sort} onSettled={locateCommentEntry} emptyUnarchived={emptyUnarchived}
      restart={() => {
        visit.current = emptyCommentSnapshot(sort);
        setRestartKey(previous => previous + 1);
      }} />
  </section>;
}

function CommentSortView({ reader, dynamicId, authorId, sort, onSettled, restart, emptyUnarchived }: {
  reader: DynamicReader; dynamicId: string; authorId: string; sort: CommentSort; onSettled(): void; restart(): void; emptyUnarchived: boolean;
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
    {state.reason === 'invalid-cursor' && <section className={styles.status}>
      <p role="alert">评论读取标记无效，请重新开始读取。</p>
      <button className={styles.button} type="button" onClick={restart}>重新开始读取</button>
    </section>}
    {state.reason === 'not-archived' && <p role="status">{unarchivedMessage}</p>}
    {!state.data && state.reason !== 'invalid-cursor' && state.reason !== 'not-archived' && <ReadNotice status={state.status} area={area} retry={load} />}
    {state.data?.items.length === 0 && <p role="status">{emptyUnarchived ? unarchivedMessage : '暂无评论'}</p>}
    <ul className={styles.comments} aria-label="一级评论">
      {state.data?.items.map(comment => <li key={comment.id} className={styles.card} data-reading-id={`comment:${comment.id}`}>
        <Identity user={comment.author} />
        {comment.author.id === authorId && <span className={styles.upBadge}>UP主</span>}
        <time className={styles.time} dateTime={comment.publishedAt ?? undefined}>{displayTime(comment.publishedAt)}</time>
        {(comment.text.trim() || !comment.pendingMediaCount) && <FoldableText text={comment.text.trim() ? comment.text : '暂无评论内容'} subject="评论"
          expanded={expanded[comment.id] ?? false}
          toggle={() => setExpanded(previous => ({ ...previous, [comment.id]: !previous[comment.id] }))} />}
        {!!comment.pendingMediaCount && <p role="status">评论图片待归档（{comment.pendingMediaCount} 张）。</p>}
        <p className={styles.count}>点赞 {comment.likeCount ?? '—'}</p>
        <p className={styles.count}>回复 {comment.replyCount ?? '—'}</p>
        {comment.replyCount !== 0 && (reader.replies === 'not-archived'
          ? <p role="status">回复尚未归档。</p>
          : <ReplySection reader={reader} dynamicId={dynamicId} authorId={authorId} rootId={comment.id} />)}
      </li>)}
    </ul>
    {state.data && state.data.items.length > 0 && (state.data.nextCursor === null
      ? <p role="status">评论已加载完毕</p>
      : <section aria-label="评论追加">
        {state.status !== 'success' && state.reason !== 'invalid-cursor' && <ReadNotice status={state.status} area={`${area}追加`} retry={load} />}
        {(state.status === 'success' || state.status === 'loading') && <button className={styles.button}
          type="button" disabled={state.status === 'loading'} onClick={() => void load()}>加载更多评论</button>}
      </section>)}
  </>;
}
