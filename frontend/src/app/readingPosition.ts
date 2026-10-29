import type { CenterPadding, ReadingPosition } from './snapshots';

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
): () => void {
  let stopped = false;
  let frame = 0;
  const stop = (): void => { stopped = true; cancelAnimationFrame(frame); };
  const release = interruptOnUserAction(() => { onUserInteraction?.(); stop(); });
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
    release();
  };
}

/**
 * 一次把阅读锚点放到视口中央：靠近首尾时按需补齐最小留白（8px），
 * 条目本来就在可滚动范围内时不加任何留白。
 * 与 `restoreReadingPosition` 同一交互语义：用户一旦滚动、触摸或按键立即放弃，
 * 不轮询、不在 resize 或重读后重跑。
 */
export function centerReadingAnchor(
  root: HTMLElement | null,
  anchorId: string | null,
  pad: (padding: CenterPadding) => void,
): () => void {
  const gap = 8;
  let stopped = false;
  let frame = 0;
  const stop = (): void => { stopped = true; cancelAnimationFrame(frame); };
  const release = interruptOnUserAction(stop);
  let padding: CenterPadding = { lead: 0, tail: 0 };

  /**
   * 文档内容底边：文档真的比视口高时 document 高度就是滚动范围；
   * 内容不足一屏时文档被布局撑到视口高度，只能按内容底边推算还差多少范围。
   */
  const contentExtent = (): number => {
    const documentHeight = document.documentElement.scrollHeight;
    if (documentHeight > window.innerHeight || !root) return documentHeight;
    return root.getBoundingClientRect().bottom + window.scrollY;
  };

  /** 量一次锚点：给出居中所需的首尾留白与目标滚动位置。 */
  const measure = (): { top: number; lead: number; tail: number } | null => {
    const anchor = readingAnchors(root).find(element => element.dataset.readingId === anchorId);
    // 锚点还没渲染出来：不猜位置，也不把页面拉回顶部。
    if (!anchor) return null;
    const box = anchor.getBoundingClientRect();
    const desired = window.scrollY + box.top - (window.innerHeight - box.height) / 2;
    const lead = desired < 0 ? Math.ceil(-desired) + gap : 0;
    // 补留白后锚点整体下移 lead，居中位置因此是 `desired + lead`（首条时为 `gap`）。
    const top = Math.max(0, desired + lead);
    // 可滚动范围按**未夹紧**的内容底边算：内容不足一屏时它可能是负数，
    // 这时尾部要补够留白，否则“居中位置”根本不可达（浏览器会把它夹回 0）。
    const unpaddedExtent = contentExtent() - padding.lead - padding.tail;
    const maximum = unpaddedExtent + lead - window.innerHeight;
    const tail = top > maximum ? Math.ceil(top - maximum) + gap : 0;
    return { top, lead, tail };
  };

  /**
   * 补留白再落点。留白会改变文档高度（内容不足一屏时连可滚动范围都依赖它），
   * 因此量到不够就补、最多补两轮，然后按最新测量落点；不轮询、不在 resize 后重跑。
   */
  const locate = (passes: number): void => {
    if (stopped) return;
    const measured = measure();
    if (!measured) return;
    // `measure` 已按“去掉现有留白后的内容底边”算出所需留白总量，这里只取较大值，
    // 不把已补的留白再加一遍。
    const next: CenterPadding = {
      lead: Math.max(padding.lead, measured.lead),
      tail: Math.max(padding.tail, measured.tail),
    };
    if (next.lead !== padding.lead || next.tail !== padding.tail) {
      padding = next;
      pad(padding);
      if (passes > 0) {
        frame = requestAnimationFrame(() => { locate(passes - 1); });
        return;
      }
    }
    window.scrollTo({ top: measured.top, left: 0, behavior: 'instant' });
    stopped = true;
  };
  frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { locate(2); }); });
  return () => {
    stop();
    release();
  };
}
