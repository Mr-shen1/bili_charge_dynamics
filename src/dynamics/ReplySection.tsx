import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { replyAppendSize, replyPreviewSize, type DynamicReader } from '../data/contracts';
import { Identity, displayTime } from './DynamicContent';
import { FoldableText } from './FoldableText';
import { ReadNotice } from './ReadNotice';
import { useDiscussionRead } from './useDiscussionRead';
import styles from './Dynamics.module.css';
import { useDiscussionVisit } from './DiscussionVisit';

export function ReplySection({ reader, dynamicId, rootId }: {
  reader: DynamicReader; dynamicId: string; rootId: string;
}) {
  const listId = useId();
  const read = useCallback((cursor: string | null | undefined, signal: AbortSignal, initial: boolean) =>
    reader.readReplies({ dynamicId, rootId, cursor, signal, limit: initial ? replyPreviewSize : replyAppendSize }),
    [reader, dynamicId, rootId]);
  const visit = useDiscussionVisit();
  const initial = useRef(visit.current.replies[rootId]);
  const { state, load } = useDiscussionRead(read, initial.current?.read);
  const [expanded, setExpanded] = useState(initial.current?.expanded ?? false);
  const [expandedTexts, setExpandedTexts] = useState<Readonly<Record<string, boolean>>>(initial.current?.expandedTexts ?? {});
  useLayoutEffect(() => {
    visit.current = { ...visit.current, replies: { ...visit.current.replies,
      [rootId]: { read: state, expanded, expandedTexts },
    } };
  }, [visit, rootId, state, expanded, expandedTexts]);
  const visible = expanded ? state.data?.items : state.data?.items.slice(0, replyPreviewSize);
  const expand = () => {
    setExpanded(true);
    if (state.data && state.data.items.length <= replyPreviewSize) void load();
  };
  return <section aria-label={`回复区 ${rootId}`}>
    {!state.data && <ReadNotice status={state.status} area="回复" retry={load} />}
    {state.data?.items.length === 0 && <p role="status">暂无回复</p>}
    <ul id={listId} className={styles.comments} aria-label="回复列表">
      {visible?.map(reply => <li key={reply.id} className={styles.reply} data-reading-id={`reply:${rootId}:${reply.id}`}>
        <Identity user={reply.author} />
        {reply.author.id === reader.creator.id && <span>UP主</span>}
        {reply.replyTo?.nickname && <p className={styles.text}>回复 @{reply.replyTo.nickname}</p>}
        <time className={styles.time} dateTime={reply.publishedAt ?? undefined}>{displayTime(reply.publishedAt)}</time>
        <FoldableText text={reply.text.trim() ? reply.text : '暂无评论内容'} subject="回复正文"
          expanded={expandedTexts[reply.id] ?? false}
          toggle={() => setExpandedTexts(previous => ({ ...previous, [reply.id]: !previous[reply.id] }))} />
        <p className={styles.count}>点赞 {reply.likeCount ?? '—'}</p>
      </li>)}
    </ul>
    {state.data && state.data.items.length > 0 && <>
      {state.status !== 'success' && <ReadNotice status={state.status} area="回复追加" retry={load} />}
      {!expanded && (state.data.items.length > replyPreviewSize || state.data.nextCursor !== null) &&
        <button type="button" className={styles.button} aria-expanded={false} aria-controls={listId}
          disabled={state.status === 'loading'} onClick={expand}>展开回复</button>}
      {expanded && <>
        {state.data.nextCursor !== null && (state.status === 'success' || state.status === 'loading') &&
          <button type="button" className={styles.button} disabled={state.status === 'loading'} onClick={() => void load()}>加载更多回复</button>}
        <button type="button" className={styles.button} aria-expanded={true} aria-controls={listId}
          onClick={() => setExpanded(false)}>收起回复</button>
      </>}
      {state.data.nextCursor === null && <p role="status">回复已加载完毕</p>}
    </>}
  </section>;
}
