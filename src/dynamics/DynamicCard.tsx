import type { MouseEvent, ReactNode } from 'react';
import { useAppNavigation } from '../app/Navigation';
import styles from './Dynamics.module.css';

// 独立链接提供键盘/新标签页语义；正文仍可选取，内部操作不是链接的子元素。
export function DynamicCard({ id, children }: { id: string; children: ReactNode }) {
  const { openDetail } = useAppNavigation();
  const selectedText = () => window.getSelection()?.isCollapsed === false;
  const normalClick = (event: MouseEvent) => event.button === 0
    && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  return <article className={`${styles.card} ${styles.dynamicCard}`} data-reading-id={id}
    onClick={event => {
      if (!normalClick(event) || selectedText() || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea, [data-card-inert]')) return;
      openDetail(id);
    }}>
    <a className={styles.cardLink} href={`/dynamics/${encodeURIComponent(id)}`} aria-label={`阅读全文 ${id}`}
      onClick={event => {
        if (!normalClick(event)) return;
        event.preventDefault();
        if (!selectedText()) openDetail(id);
      }} />
    {children}
  </article>;
}
