import { onBeforeUnmount, onMounted, ref } from 'vue';

// 窄屏阈值与规格一致（≤640px）；无法判定时按宽屏，宽屏行为不因探测失败而消失。
const compactQuery = '(max-width: 640px)';

export function useCompactViewport() {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia(compactQuery) : null;
  const compact = ref(query?.matches ?? false);
  const update = (event: MediaQueryListEvent): void => { compact.value = event.matches; };
  onMounted(() => query?.addEventListener('change', update));
  onBeforeUnmount(() => query?.removeEventListener('change', update));
  return compact;
}
