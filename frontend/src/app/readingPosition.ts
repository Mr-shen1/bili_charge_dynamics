import type { ReadingPosition } from './snapshots';

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

// 只有会改变阅读位置的按键才算“用户已接管”，Tab/Escape 等不影响定位。
const readingKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];

/**
 * 注册会让“定位评论区”失效的用户操作（滚动、触摸、翻页键）。
 * 定位纠正遇到这些操作必须让位；返回解除函数，重新注册前应先解除上一组。
 */
export function onUserScroll(cancel: () => void): () => void {
  const onKey = (event: Event): void => {
    if (readingKeys.includes((event as KeyboardEvent).key)) cancel();
  };
  const events: [string, EventListener, AddEventListenerOptions][] = [
    ['wheel', cancel, { passive: true }], ['touchmove', cancel, { passive: true }], ['keydown', onKey, {}],
  ];
  for (const [name, listener, options] of events) window.addEventListener(name, listener, options);
  return () => {
    for (const [name, listener] of events) window.removeEventListener(name, listener);
  };
}

/**
 * 由应用导航协调器统一定位；最多等待两个布局帧，不轮询读取或图片。
 * 内容范围和展开状态由页面先同步还原，缺失锚点立即走有界像素后备。
 * 用户一旦主动滚动、触摸或按键，立即停止纠正。
 */
export function restoreReadingPosition(
  root: HTMLElement | null,
  position: ReadingPosition | null,
  onUserInteraction?: () => void,
): () => void {
  let stopped = false;
  let frame = 0;
  const stop = (): void => { stopped = true; cancelAnimationFrame(frame); };
  const stopOnInteraction = (): void => { onUserInteraction?.(); stop(); };
  const stopOnKey = (event: KeyboardEvent): void => {
    if (readingKeys.includes(event.key)) stopOnInteraction();
  };
  window.addEventListener('wheel', stopOnInteraction, { passive: true });
  window.addEventListener('touchmove', stopOnInteraction, { passive: true });
  window.addEventListener('pointerdown', stopOnInteraction, { passive: true });
  window.addEventListener('keydown', stopOnKey);
  const locate = (): void => {
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
    window.removeEventListener('wheel', stopOnInteraction);
    window.removeEventListener('touchmove', stopOnInteraction);
    window.removeEventListener('pointerdown', stopOnInteraction);
    window.removeEventListener('keydown', stopOnKey);
  };
}
