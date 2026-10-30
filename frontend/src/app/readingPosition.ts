import type { ReadingPosition } from './snapshots';

/**
 * 阅读落点的滚动源：默认是文档（整页），也可以是一段自己的滚动容器（桌面会话弹窗）。
 * 三种读数都从这里取，页面与弹窗因此共用同一套落点语义。
 */
interface ScrollPort {
  /** 当前滚动位置。 */
  position(): number;
  /** 可视区高度。 */
  viewport(): number;
  /** 最大可滚动值。 */
  maximum(): number;
  /** 目标相对可视区顶边的偏移。 */
  topOf(element: Element): number;
  scrollTo(top: number): void;
}

function windowPort(): ScrollPort {
  return {
    position: () => window.scrollY,
    viewport: () => window.innerHeight,
    maximum: () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    topOf: element => element.getBoundingClientRect().top,
    scrollTo: top => window.scrollTo({ top, left: 0, behavior: 'instant' }),
  };
}

function elementPort(element: HTMLElement): ScrollPort {
  const box = (): DOMRect => element.getBoundingClientRect();
  return {
    position: () => element.scrollTop,
    viewport: () => element.clientHeight,
    maximum: () => Math.max(0, element.scrollHeight - element.clientHeight),
    topOf: target => target.getBoundingClientRect().top - box().top,
    scrollTo: top => {
      // jsdom 没有 Element.scrollTo：退回直接赋值，行为一致。
      if (typeof element.scrollTo === 'function') element.scrollTo({ top, left: 0, behavior: 'instant' });
      else element.scrollTop = top;
    },
  };
}

/** `scroller` 为真时在该容器内滚动，否则按整页文档滚动。 */
function scrollPort(scroller: HTMLElement | null | undefined): ScrollPort {
  return scroller ? elementPort(scroller) : windowPort();
}

function readingAnchors(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('[data-reading-id]') ?? []);
}

export function captureReadingPosition(
  root: HTMLElement | null,
  scroller?: HTMLElement | null,
): ReadingPosition {
  const port = scrollPort(scroller);
  const elements = readingAnchors(root);
  const anchor = elements.find(element => {
    const top = port.topOf(element);
    return top >= 0 && top < port.viewport();
  }) ?? elements.find(element => port.topOf(element) + element.getBoundingClientRect().height > 0);
  return {
    anchorId: anchor?.dataset.readingId ?? null,
    viewportOffset: anchor ? port.topOf(anchor) : 0,
    pixelY: port.position(),
  };
}

// 只有会改变阅读位置的按键才算“用户已接管”，Tab/Escape 等不影响定位。
const readingKeys = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '];

/**
 * 注册“用户已经自己动过”的操作：一旦滚动、触摸、按下或翻页就调用 `interrupt`，
 * 让一次性定位让位。返回解除函数，重用同一实例前应先解除上一组。
 */
function interruptOnUserAction(interrupt: () => void): () => void {
  const onKey = (event: Event): void => {
    if (readingKeys.includes((event as KeyboardEvent).key)) interrupt();
  };
  const events: [string, EventListener, AddEventListenerOptions][] = [
    ['wheel', interrupt, { passive: true }],
    ['touchmove', interrupt, { passive: true }],
    ['pointerdown', interrupt, { passive: true }],
    ['keydown', onKey, {}],
  ];
  for (const [name, listener, options] of events) window.addEventListener(name, listener, options);
  return () => {
    for (const [name, listener] of events) window.removeEventListener(name, listener);
  };
}

/**
 * 注册会让“定位评论区”失效的用户操作（滚动、触摸、翻页键）。
 * 定位纠正遇到这些操作必须让位；返回解除函数，重新注册前应先解除上一组。
 * 比一次性阅读定位窄一档：单纯按下不改变阅读位置，不打断待落下的定位。
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
  scroller?: HTMLElement | null,
): () => void {
  let stopped = false;
  let frame = 0;
  const port = scrollPort(scroller);
  const stop = (): void => { stopped = true; cancelAnimationFrame(frame); };
  const release = interruptOnUserAction(() => { onUserInteraction?.(); stop(); });
  const locate = (): void => {
    if (stopped) return;
    const anchor = readingAnchors(root)
      .find(element => element.dataset.readingId === position?.anchorId);
    const target = position
      ? anchor ? port.position() + port.topOf(anchor) - position.viewportOffset : position.pixelY
      : 0;
    port.scrollTo(Math.max(0, Math.min(target, port.maximum())));
    stopped = true;
  };
  if (!position) locate();
  else frame = requestAnimationFrame(() => { frame = requestAnimationFrame(locate); });
  return () => {
    stop();
    release();
  };
}

/**
 * 一次把阅读锚点放到视口中央，位置夹在真实可滚动范围内：不补任何留白，
 * 所以短会话停在顶部、末条停在底部，入口可见且不留空白带。
 * 与 `restoreReadingPosition` 同一交互语义：用户一旦滚动、触摸或按键立即放弃，
 * 不轮询、不在 resize 或重读后重跑。
 */
export function centerReadingAnchor(
  root: HTMLElement | null,
  anchorId: string | null,
  scroller?: HTMLElement | null,
): () => void {
  let stopped = false;
  let frame = 0;
  const port = scrollPort(scroller);
  const stop = (): void => { stopped = true; cancelAnimationFrame(frame); };
  const release = interruptOnUserAction(stop);

  /** 量一次锚点：给出夹紧后的目标滚动位置；锚点还没渲染时不猜位置，也不把页面拉回顶部。 */
  const locate = (): void => {
    if (stopped) return;
    const anchor = readingAnchors(root).find(element => element.dataset.readingId === anchorId);
    if (!anchor) return;
    const height = anchor.getBoundingClientRect().height;
    const desired = port.position() + port.topOf(anchor) - (port.viewport() - height) / 2;
    port.scrollTo(Math.min(Math.max(0, desired), port.maximum()));
    stopped = true;
  };
  frame = requestAnimationFrame(() => { frame = requestAnimationFrame(locate); });
  return () => {
    stop();
    release();
  };
}
