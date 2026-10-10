import type { DetailResult } from '../data/contracts';
import styles from './Dynamics.module.css';

export function ReadNotice({ status, area, retry }: {
  status: DetailResult['status'] | 'loading';
  // 展示文案由调用区域提供，本组件不承担领域/排序/阶段的选择。
  area: string;
  retry(): void;
}) {
  if (status === 'loading') return <p role="status" className={styles.status}>{area}加载中…</p>;
  if (status !== 'error' && status !== 'cancelled') return null;
  return <section className={styles.status}>
    {status === 'error' ? <p role="alert">{area}读取失败，请重试。</p> : <p role="status">读取已取消，可重新读取。</p>}
    <button className={styles.button} type="button" onClick={retry}>{status === 'error' ? '重试' : '重新读取'}</button>
  </section>;
}
