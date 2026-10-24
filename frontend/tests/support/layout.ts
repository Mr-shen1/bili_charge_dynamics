import { vi } from 'vitest';

export interface FakeLayout {
  /** 元素文档位置的附加位移，用于模拟返回后布局变化。 */
  shift: number;
  scrollTo: ReturnType<typeof vi.fn>;
  scrollY(): number;
  setScrollY(value: number): void;
  restore(): void;
}

/**
 * jsdom 没有排版与滚动：只给阅读锚点 `[data-reading-id]` 合成确定的位置，
 * 第 index 个锚点的文档位置为 100 + index * 300 + shift，视口位置随 scrollY 变化。
 * 其余元素的位置保持 0，不改变页面断言。
 */
export function installFakeLayout(): FakeLayout {
  let scrollY = 0;
  let shift = 0;
  const scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    scrollY = typeof options === 'number' ? (y ?? 0) : (options?.top ?? 0);
  });
  const windowScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
  const windowScrollTo = Object.getOwnPropertyDescriptor(window, 'scrollTo');
  const scrollHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight');
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
  Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: scrollTo });
  Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 20000 });
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const anchors = Array.from(document.querySelectorAll<HTMLElement>('[data-reading-id]'));
    const index = anchors.indexOf(this);
    const documentTop = index < 0 ? 0 : 100 + index * 300 + shift;
    const height = index < 0 ? 0 : 260;
    const top = documentTop - scrollY;
    return { top, bottom: top + height, height, width: 0, left: 0, right: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  const restoreProperty = (target: object, name: string, descriptor?: PropertyDescriptor): void => {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else Reflect.deleteProperty(target, name);
  };
  return {
    get shift() { return shift; },
    set shift(value: number) { shift = value; },
    scrollTo,
    scrollY: () => scrollY,
    setScrollY: value => { scrollY = value; },
    restore() {
      rect.mockRestore();
      restoreProperty(window, 'scrollY', windowScrollY);
      restoreProperty(window, 'scrollTo', windowScrollTo);
      restoreProperty(document.documentElement, 'scrollHeight', scrollHeight);
    },
  };
}
