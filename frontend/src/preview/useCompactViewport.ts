import { onBeforeUnmount, onMounted, ref } from 'vue';

// 窄屏阈值与规格一致（≤640px）；宽屏仍走库原生的图标工具栏与箭头。
const compactQuery = '(max-width: 640px)';

export function useCompactViewport() {
  const query = window.matchMedia(compactQuery);
  const compact = ref(query.matches);
  const update = (event: MediaQueryListEvent): void => { compact.value = event.matches; };
  onMounted(() => query.addEventListener('change', update));
  onBeforeUnmount(() => query.removeEventListener('change', update));
  return compact;
}
