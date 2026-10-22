import { useSyncExternalStore } from 'react';

// 手机排版与桌面排版是两套已验证的交互；这里只做视口判定，不读设备或 UA。
const QUERY = '(max-width: 640px)';

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function compactSnapshot() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(QUERY).matches;
}

/** 无法判定视口时（jsdom、旧浏览器）按桌面排版处理。 */
export function useCompactViewport(): boolean {
  return useSyncExternalStore(subscribe, compactSnapshot, () => false);
}
