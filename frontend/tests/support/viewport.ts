import { vi } from 'vitest';

let original: PropertyDescriptor | undefined;

/**
 * jsdom 没有 `matchMedia`：按给定结果模拟窄屏媒体查询（640px 阈值）。
 * 与真实浏览器一致地提供 `matches`、`media` 与 change 订阅接口；
 * 无法判定（不安装）时被 `useCompactViewport` 视为宽屏。
 */
export function installCompactViewport(matches: boolean): void {
  original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })));
}

/** 还原安装前的全局状态，回到“浏览器不提供 matchMedia”的宽屏兜底。 */
export function removeCompactViewport(): void {
  vi.unstubAllGlobals();
  if (original) Object.defineProperty(window, 'matchMedia', original);
  original = undefined;
}
