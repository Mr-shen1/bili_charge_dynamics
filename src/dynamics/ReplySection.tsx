import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { replyAppendSize, replyPreviewSize, type DynamicReader, type ReplyBatch } from '../data/contracts';
import { Identity, displayTime } from './DynamicContent';
import { ReadOnlyLikeCount } from './ReadOnlyLikeCount';
import { FoldableText } from './FoldableText';
import { ReadNotice } from './ReadNotice';
import { useDiscussionRead } from './useDiscussionRead';
import styles from './Dynamics.module.css';
import { useDiscussionVisit } from './DiscussionVisit';

function describeReplyArchive(batch: ReplyBatch | null) {
  if (!batch || batch.repliesLastAttempt === 'success') return null;
  if (batch.repliesLastAttempt === 'failed') return '回复最近归档失败；已保存回复仍可阅读。';
  if (batch.repliesLastAttempt === 'pending') return '回复尚未完成归档。';
  if (batch.repliesLastAttempt === 'unconfirmed' || batch.sourceReplyCount !== undefined || batch.localReplyCount !== undefined)
    return '回复归档尚未确认完成。';
  return null;
}

export function ReplySection({ reader, dynamicId, authorId, rootId }: {
  reader: DynamicReader; dynamicId: string; authorId: string; rootId: string;
}) {
  const listId = useId();
  const read = useCallback((cursor: string | null | undefined, signal: AbortSignal, initial: boolean) =>
    reader.readReplies({ dynamicId, rootId, cursor, signal, limit: initial ? replyPreviewSize : replyAppendSize }),
    [reader, dynamicId, rootId]);
  const visit = useDiscussionVisit();
  const initial = useRef(visit.current.replies[rootId]);
  const { state, load, restart } = useDiscussionRead(read, initial.current?.read);
  const [expanded, setExpanded] = useState(initial.current?.expanded ?? false);
  const section = useRef<HTMLElement>(null);
  const collapseRequested = useRef(false);
  useLayoutEffect(() => {
    if (expanded || !collapseRequested.current) return;
    collapseRequested.current = false;
    section.current?.closest<HTMLElement>('[data-reading-id^="comment:"]')?.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }, [expanded]);
  const [expandedTexts, setExpandedTexts] = useState<Readonly<Record<string, boolean>>>(initial.current?.expandedTexts ?? {});
  useLayoutEffect(() => {
    visit.current = { ...visit.current, replies: { ...visit.current.replies,
      [rootId]: { read: state, expanded, expandedTexts },
    } };
  }, [visit, rootId, state, expanded, expandedTexts]);
  const visible = expanded ? state.data?.items : state.data?.items.slice(0, replyPreviewSize);
  const archiveNotice = describeReplyArchive(state.data);
  const redundantCounts = state.data?.repliesLastAttempt === 'success'
    && state.data.sourceReplyCount != null && state.data.localReplyCount != null
    && state.data.sourceReplyCount === state.data.localReplyCount;
  const expand = () => {
    setExpanded(true);
    if (state.data && state.data.items.length <= replyPreviewSize) void load();
  };
  const invalidCursor = state.reason === 'invalid-cursor';
  return <section ref={section} className={styles.replySection} aria-label={`回复区 ${rootId}`}>
    {invalidCursor && <section className={styles.status}>
      <p role="alert">回复读取标记无效，请重新开始读取。</p>
      <button type="button" className={styles.button} onClick={() => {
        setExpanded(false);
        setExpandedTexts({});
        restart();
      }}>重新开始读取</button>
    </section>}
    {!state.data && !invalidCursor && <ReadNotice status={state.status} area="回复" retry={load} />}
    {state.data && <>
      {!redundantCounts &&
        <p className={styles.count}>来源回复：{state.data.sourceReplyCount ?? '—'}；本地已归档回复：{state.data.localReplyCount ?? '—'}</p>}
      {archiveNotice && <p role="status">{archiveNotice}</p>}
      {state.data.items.length === 0 && !archiveNotice && <p role="status">暂无回复</p>}
    </>}
    <ul id={listId} className={styles.comments} aria-label="回复列表">
      {visible?.map(reply => <li key={reply.id} className={`${styles.reply} ${reply.author.id === authorId ? styles.authorComment : ''}`} data-reading-id={`reply:${rootId}:${reply.id}`}>
        <div className={styles.replyLine}>
          <FoldableText text={reply.text.trim() ? reply.text : '暂无评论内容'} subject="回复正文"
            prefix={<><Identity user={reply.author} inline />{' '}
              {reply.author.id === authorId && <><span className={styles.upBadge}>UP主</span>{' '}</>}
              {reply.replyTo?.nickname && <><span className={styles.replyTarget}>回复 @{reply.replyTo.nickname}</span>{' '}</>}
            </>}
            expanded={expandedTexts[reply.id] ?? false}
            toggle={() => setExpandedTexts(previous => ({ ...previous, [reply.id]: !previous[reply.id] }))} />
        </div>
        <div className={styles.metrics}>
          <time className={styles.time} dateTime={reply.publishedAt ?? undefined}>{displayTime(reply.publishedAt)}</time>
          <ReadOnlyLikeCount count={reply.likeCount} />
        </div>
      </li>)}
    </ul>
    {state.data && state.data.items.length > 0 && <>
      {state.status !== 'success' && !invalidCursor && <ReadNotice status={state.status} area="回复追加" retry={load} />}
      {!expanded && (state.data.items.length > replyPreviewSize || state.data.nextCursor !== null) &&
        <button type="button" className={styles.button} aria-label="展开回复" aria-expanded={false} aria-controls={listId}
          disabled={state.status === 'loading' || invalidCursor} onClick={expand}>
          {state.data.sourceReplyCount != null ? `共${state.data.sourceReplyCount}条回复，点击查看` : '展开回复'}
        </button>}
      {expanded && <>
        {state.data.nextCursor !== null && (state.status === 'success' || state.status === 'loading') &&
          <button type="button" className={styles.button} disabled={state.status === 'loading'} onClick={() => void load()}>加载更多回复</button>}
        <button type="button" className={styles.button} aria-expanded={true} aria-controls={listId}
          onClick={() => {
            collapseRequested.current = true;
            setExpanded(false);
          }}>收起回复</button>
      </>}
      {state.data.nextCursor === null && <p role="status">{archiveNotice ? '本地归档回复已读完' : '回复已加载完毕'}</p>}
    </>}
  </section>;
}
