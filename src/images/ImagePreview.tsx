import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DynamicImage } from '../data/contracts';
import styles from './Images.module.css';
import { ContentImage } from './ContentImage';

export interface PreviewSession {
  readonly previewId: string;
  readonly pageEntryId: string;
  readonly images: readonly DynamicImage[];
  readonly initialIndex: number;
  readonly triggerId: string;
}

export function ImagePreview({ preview, close }: { preview: PreviewSession; close(): void }) {
  const root = useRef<HTMLElement>(null);
  const trapping = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [index, setIndex] = useState(preview.initialIndex);
  const move = (offset: number) => setIndex(current => Math.max(0, Math.min(preview.images.length - 1, current + offset)));
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const controls = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const current = controls.findIndex(control => control === document.activeElement);
        const next = event.shiftKey ? (current - 1 + controls.length) % controls.length : (current + 1) % controls.length;
        event.preventDefault();
        controls[next]?.focus({ preventScroll: true });
      }
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    };
    const constrainFocus = (event: FocusEvent) => {
      if (trapping.current && event.target instanceof Node && !root.current?.contains(event.target)) closeButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', constrainFocus);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', constrainFocus);
    };
  }, [close, preview.images.length]);
  useLayoutEffect(() => {
    trapping.current = true;
    const x = window.scrollX;
    const y = window.scrollY;
    const previous = { position: document.body.style.position, top: document.body.style.top,
      left: document.body.style.left, width: document.body.style.width };
    Object.assign(document.body.style, { position: 'fixed', top: `${-y}px`, left: `${-x}px`, width: '100%' });
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      trapping.current = false;
      Object.assign(document.body.style, previous);
      window.scrollTo({ top: y, left: x, behavior: 'instant' });
      // 删除预览的 layout cleanup 早于父节点解除 inert；提交后再聚焦，且不覆盖新预览。
      queueMicrotask(() => {
        if (document.querySelector('[role="dialog"][aria-label="图片预览"]')) return;
        const target = document.getElementById(preview.triggerId) ?? document.querySelector<HTMLElement>('main');
        target?.focus({ preventScroll: true });
      });
    };
  }, [preview]);
  const image = preview.images[index]!;
  return <section ref={root} role="dialog" aria-modal="true" aria-label="图片预览" className={styles.preview}>
    <header className={styles.toolbar}>
      <span aria-live="polite">{index + 1} / {preview.images.length}</span>
      {preview.images.length > 1 && <>
        <button className={styles.action} type="button" disabled={index === 0} onClick={() => move(-1)}>上一张</button>
        <button className={styles.action} type="button" disabled={index === preview.images.length - 1} onClick={() => move(1)}>下一张</button>
      </>}
      <button ref={closeButton} className={styles.action} type="button" onClick={close}>关闭预览</button>
    </header>
    <div className={styles.stage}><ContentImage key={image.id} image={image} preview label={`预览图片 ${index + 1}`} /></div>
  </section>;
}
