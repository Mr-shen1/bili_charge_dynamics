import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useParams } from 'react-router';
import { useAppNavigation } from '../app/Navigation';
import type { DynamicReader } from '../data/contracts';
import { displayTime, Identity } from './DynamicContent';
import { replyBodyText } from './replyText';
import { ReadNotice } from './ReadNotice';
import { ReadOnlyLikeCount } from './ReadOnlyLikeCount';
import { useReplyPage } from './useReplyPage';
import { ReplyPager, replyPageSize } from './ReplyPager';
import styles from './Dynamics.module.css';

/** 手机端楼中楼详情：根评论固定在上方，下面按时间正序读已归档回复。 */
export function CommentThreadPage({ reader }: { reader: DynamicReader }) {
  const { pageEntryId } = useAppNavigation();
  return <ThreadVisit key={pageEntryId} reader={reader} />;
}

function ThreadVisit({ reader }: { reader: DynamicReader }) {
  const { dynamicId = '', rootId = '' } = useParams();
  const { returnFromThread } = useAppNavigation();
  const read = useCallback((page: number, signal: AbortSignal) =>
    reader.readReplies({ dynamicId, rootId, page, signal, limit: replyPageSize }), [reader, dynamicId, rootId]);
  const { state, loadPage, retry } = useReplyPage(read);
  // 只为标注“UP主”徽标读取作者 ID；失败时不标注，不影响回复正文。
  const [authorId, setAuthorId] = useState<string | null>(null);
  useLayoutEffect(() => { window.scrollTo?.({ top: 0 }); }, []);
  useEffect(() => {
    const active = new AbortController();
    void reader.readDetail({ id: dynamicId, signal: active.signal }).then(result => {
      if (active.signal.aborted || result.status !== 'success') return;
      setAuthorId(result.data.author.id);
    }).catch(() => {});
    return () => active.abort();
  }, [reader, dynamicId]);
  const data = state.data;
  const root = data?.root ?? null;
  const total = data?.sourceReplyCount ?? data?.count ?? data?.items.length ?? 0;
  const pages = Math.max(1, Math.ceil((data?.count ?? data?.localReplyCount ?? data?.items.length ?? 0) / replyPageSize));
  const currentPage = Math.min(state.page, pages);
  const visible = data?.items ?? [];
  const unreturned = data?.sourceReplyCount != null && data.localReplyCount != null
    && data.sourceReplyCount > data.localReplyCount ? data.sourceReplyCount - data.localReplyCount : 0;
  return <main className={styles.threadPage}>
    <header className={styles.threadHeader}>
      <button type="button" className={styles.threadBack} aria-label="返回评论"
        onClick={() => returnFromThread(dynamicId)}>‹ <span>评论详情</span></button>
    </header>
    <div className={styles.threadSurface}>
    {state.reason === 'invalid-cursor' && <section className={styles.status}>
      <p role="alert">回复读取标记无效，请重新开始读取。</p>
      <button className={styles.button} type="button" onClick={() => void loadPage(1)}>重新开始读取</button>
    </section>}
    {!state.data && state.reason !== 'invalid-cursor' && <ReadNotice status={state.status} area="相关回复" retry={retry} />}
    {state.data && !root && <p role="status">评论不存在或已不可读</p>}
    {root && data && <>
      <article className={`${styles.threadRoot} ${root.author.id === authorId ? styles.threadUp : ''}`}
        aria-label="被回复的评论">
        <div className={styles.discussionHead}>
          <Identity user={root.author} />
          {root.author.id === authorId && <span className={styles.upBadge}>UP</span>}
          {root.isPinned && <span className={styles.pinnedBadge}>置顶</span>}
        </div>
        <div className={styles.commentBody}>
          <p className={styles.threadRootText}>{root.text.trim() || '暂无评论内容'}</p>
          <div className={styles.metrics}>
            <time className={styles.time} dateTime={root.publishedAt ?? undefined}>{displayTime(root.publishedAt)}</time>
            <ReadOnlyLikeCount count={root.likeCount} />
          </div>
        </div>
      </article>
      <div className={styles.threadSummary}>
        <h1>相关回复共{total}条</h1>
        <span className={styles.threadSort}>按时间</span>
      </div>
      {unreturned > 0 && <p className={styles.count}>已归档 {data.localReplyCount}/{data.sourceReplyCount}，上游另有 {unreturned} 条回复未返回。</p>}
      <ul className={styles.comments} aria-label="相关回复">
        {visible.map(reply => <li key={reply.id}
          className={`${styles.threadReply} ${reply.author.id === authorId ? styles.threadUp : ''}`}
          data-reading-id={`reply:${rootId}:${reply.id}`}>
          <div className={styles.discussionHead}>
            <Identity user={reply.author} />
            {reply.author.id === authorId && <span className={styles.upBadge}>UP</span>}
          </div>
          <div className={styles.commentBody}>
            <p className={styles.threadReplyText}>
              {reply.parentId && reply.replyTo?.nickname &&
                <><span className={styles.replyPreviewTarget}>回复 {reply.replyTo.nickname}:</span>{' '}</>}
              {replyBodyText(reply.text).trim() || '暂无评论内容'}
            </p>
            <div className={styles.metrics}>
              <time className={styles.time} dateTime={reply.publishedAt ?? undefined}>{displayTime(reply.publishedAt)}</time>
              <ReadOnlyLikeCount count={reply.likeCount} />
            </div>
          </div>
        </li>)}
      </ul>
      {data.items.length === 0 && <p role="status">暂无回复</p>}
      {state.status !== 'success' && state.reason !== 'invalid-cursor' && <ReadNotice status={state.status} area="相关回复追加" retry={retry} />}
        {total > 0 && <ReplyPager page={currentPage} pages={pages} busy={state.status === 'loading' || state.reason === 'invalid-cursor'}
          onSelect={page => void loadPage(page)}
          onCollapse={() => returnFromThread(dynamicId)} />}
      </>}
    </div>
  </main>;
}
