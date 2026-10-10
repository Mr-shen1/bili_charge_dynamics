import type { DetailResult } from '../data/contracts';
import styles from './Dynamics.module.css';

export function ReadNotice({ status, area, retry }: {
  status: DetailResult['status'] | 'loading';
  area: '动态列表' | '动态详情' | '动态追加';
  retry(): void;
}) {
  if (status === 'loading') return <p role="status" className={styles.status}>{area}加载中…</p>;
  if (status !== 'error' && status !== 'cancelled') return null;
  return <section className={styles.status}>
    {status === 'error' ? <p role="alert">{area}读取失败，请重试。</p> : <p role="status">读取已取消，可重新读取。</p>}
    <button className={styles.button} type="button" onClick={retry}>{status === 'error' ? '重试' : '重新读取'}</button>
  </section>;
}
