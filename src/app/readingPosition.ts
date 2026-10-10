import type { ReadingPosition } from './ListSnapshot';

function readingAnchors(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-reading-id]') ?? []);
}

export function captureReadingPosition(root: HTMLElement | null): ReadingPosition {
  const elements = readingAnchors(root);
  const anchor = elements.find(element => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.top < window.innerHeight;
  }) ?? elements.find(element => element.getBoundingClientRect().bottom > 0);
  return {
    anchorId: anchor?.dataset.readingId ?? null,
    viewportOffset: anchor?.getBoundingClientRect().top ?? 0,
    pixelY: window.scrollY,
  };
}

// 由应用统一定位；最多等待两个布局帧，不轮询读取或图片。
// 内容范围和展开状态由页面先同步还原，缺失锚点立即走有界像素后备。
export function restoreReadingPosition(root: HTMLElement | null, position: ReadingPosition | null): () => void {
  let stopped = false;
  let frame = 0;
  const stop = () => { stopped = true; cancelAnimationFrame(frame); };
  const stopOnKey = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) stop();
  };
  window.addEventListener('wheel', stop, { passive: true });
  window.addEventListener('touchmove', stop, { passive: true });
  window.addEventListener('pointerdown', stop, { passive: true });
  window.addEventListener('keydown', stopOnKey);
  const locate = () => {
    if (stopped) return;
    const anchor = readingAnchors(root)
      .find(element => element.dataset.readingId === position?.anchorId);
    const target = position
      ? anchor ? window.scrollY + anchor.getBoundingClientRect().top - position.viewportOffset : position.pixelY
      : 0;
    const maximum = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.max(0, Math.min(target, maximum)), left: 0, behavior: 'instant' });
    stopped = true;
  };
  if (!position) locate();
  else frame = requestAnimationFrame(() => { frame = requestAnimationFrame(locate); });
  return () => {
    stop();
    window.removeEventListener('wheel', stop);
    window.removeEventListener('touchmove', stop);
    window.removeEventListener('pointerdown', stop);
    window.removeEventListener('keydown', stopOnKey);
  };
}
