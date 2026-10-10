import { useId, useLayoutEffect, useRef, useState } from 'react';
import styles from './Dynamics.module.css';

// scrollHeight 按整数像素取整，留出一个像素避免恰好六行误判。
const layoutRoundingTolerance = 1;

export function FoldableText({ text, expanded, toggle, subject = '正文' }: {
  text: string; expanded: boolean; toggle(): void; subject?: '正文' | '评论';
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
  }, [text]);
  return <>
    <p id={id} ref={paragraph} className={`${styles.text} ${expanded ? '' : styles.collapsed}`}>{text}</p>
    {overflowing && <button type="button" className={styles.button} aria-expanded={expanded}
      aria-controls={id} onClick={toggle}>{expanded ? `收起${subject}` : `展开${subject}`}</button>}
  </>;
}
