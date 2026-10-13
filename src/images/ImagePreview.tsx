import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { DynamicImage } from '../data/contracts';
import styles from './Images.module.css';
import { ContentImage } from './ContentImage';

const gestureDirectionThreshold = 12;
const imageSwipeThreshold = 50;
const horizontalDominanceRatio = 1.5;
const longImageHeightRatio = 2;

export interface ImageOwner {
  readonly type: 'dynamic' | 'comment';
  readonly id: string;
}

export interface PreviewSession {
  readonly owner: ImageOwner;
  readonly previewId: string;
  readonly pageEntryId: string;
  readonly images: readonly DynamicImage[];
  readonly currentIndex: number;
  readonly displayMode: 'contain' | 'width';
  readonly triggerId: string;
}

export function ImagePreview({ preview, close, moveImage, changeMode }: {
  preview: PreviewSession; close(): void; moveImage(previewId: string, offset: number): void;
  changeMode(previewId: string, mode: PreviewSession['displayMode']): void;
}) {
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; x: number; y: number; axis: 'pending' | 'horizontal' | 'vertical' } | null>(null);
  const trapping = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [loadedDimensions, setLoadedDimensions] = useState<{ imageId: string; width: number; height: number } | null>(null);
  const index = preview.currentIndex;
  const move = useCallback((offset: number) => {
    moveImage(preview.previewId, offset);
  }, [moveImage, preview.previewId]);
  const startGesture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    if (!event.isPrimary || gesture.current) { gesture.current = null; return; }
    gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, axis: 'pending' };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const trackGesture = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || current.axis !== 'pending') return;
    const dx = Math.abs(event.clientX - current.x);
    const dy = Math.abs(event.clientY - current.y);
    // 先锁定方向：模糊的斜向运动交给纵向阅读，不把阅读动作猜成切图。
    if (Math.max(dx, dy) >= gestureDirectionThreshold) current.axis = dx >= dy * horizontalDominanceRatio ? 'horizontal' : 'vertical';
  };
  const endGesture = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = null;
    if (!current || current.pointerId !== event.pointerId || current.axis !== 'horizontal') return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (Math.abs(dx) >= imageSwipeThreshold && Math.abs(dx) >= Math.abs(dy) * horizontalDominanceRatio) move(dx < 0 ? 1 : -1);
  };
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
  }, [close, move]);
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
  }, [preview.previewId, preview.triggerId]);
  useLayoutEffect(() => { if (stage.current) stage.current.scrollTop = 0; }, [index, preview.displayMode]);
  const image = preview.images[index]!;
  // 高宽比至少 2:1 的图片提供长图阅读模式；默认仍完整显示。
  const dimensions = loadedDimensions?.imageId === image.id ? loadedDimensions : image;
  const isLongImage = !!dimensions.width && !!dimensions.height && dimensions.height / dimensions.width >= longImageHeightRatio;
  const fitWidth = isLongImage && preview.displayMode === 'width';
  return <section ref={root} role="dialog" aria-modal="true" aria-label="图片预览" className={styles.preview}>
    <header className={styles.toolbar}>
      <span aria-live="polite">{index + 1} / {preview.images.length}</span>
      {preview.images.length > 1 && <>
        <button className={styles.action} type="button" disabled={index === 0} onClick={() => move(-1)}>上一张</button>
        <button className={styles.action} type="button" disabled={index === preview.images.length - 1} onClick={() => move(1)}>下一张</button>
      </>}
      {isLongImage && <button className={styles.action} type="button" aria-pressed={fitWidth}
        onClick={() => changeMode(preview.previewId, fitWidth ? 'contain' : 'width')}>
        {fitWidth ? '完整显示' : '适应宽度'}
      </button>}
      <button ref={closeButton} className={styles.action} type="button" onClick={close}>关闭预览</button>
    </header>
    <div ref={stage} role="region" aria-label="预览图片阅读区域" className={`${styles.stage} ${fitWidth ? styles.widthStage : ''}`}
      onPointerDown={startGesture} onPointerMove={trackGesture} onPointerUp={endGesture}
      onPointerCancel={() => { gesture.current = null; }} onLostPointerCapture={() => { gesture.current = null; }}>
      <ContentImage key={image.id} image={image} preview label={`预览图片 ${index + 1}`}
        onDimensions={(width, height) => setLoadedDimensions({ imageId: image.id, width, height })} />
    </div>
  </section>;
}
