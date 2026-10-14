import styles from './Dynamics.module.css';

/** 归档点赞数仅展示，不提供点赞操作。 */
export function ReadOnlyLikeCount({ count }: { count: number | null }) {
  return <span role="group" aria-label={`点赞 ${count ?? '—'}`} className={`${styles.count} ${styles.likeCount}`}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M8 10 12 3c.7-1.2 3-.7 3 1v5h5c1.5 0 2 1 1.8 2l-1.5 8c-.2 1-1 2-2.3 2H8V10Z" />
      <path d="M3 10h5v11H3z" />
    </svg><span aria-hidden="true">{count ?? '—'}</span>
  </span>;
}
