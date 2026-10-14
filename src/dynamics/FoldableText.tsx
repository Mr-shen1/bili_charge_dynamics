import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Dynamics.module.css';

// scrollHeight 按整数像素取整，留出一个像素避免恰好六行误判。
const layoutRoundingTolerance = 1;

export function FoldableText({ text, expanded, toggle, subject = '正文', prefix }: {
  text: string; expanded: boolean; toggle(): void; subject?: '正文' | '评论' | '回复正文'; prefix?: ReactNode;
}) {
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const element = paragraph.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const lineHeight = parseFloat(style.lineHeight);
      const collapsedLines = parseFloat(style.getPropertyValue('--collapsed-lines'));
      setOverflowing(element.scrollHeight > lineHeight * collapsedLines + layoutRoundingTolerance);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [text, prefix]);
  return <>
    <p id={id} ref={paragraph} className={`${styles.text} ${expanded ? '' : styles.collapsed}`}>{prefix}{text}</p>
    {overflowing && <button type="button" className={`${styles.button} ${styles.foldToggle}`} aria-expanded={expanded}
      aria-label={`${expanded ? '收起' : '展开'}${subject}`} aria-controls={id} onClick={toggle}>{expanded ? '收起' : '展开'}</button>}
  </>;
}
