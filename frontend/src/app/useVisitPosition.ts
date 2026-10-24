import { onBeforeUnmount, onMounted, type Ref } from 'vue';
import { captureReadingPosition, restoreReadingPosition } from './readingPosition';
import type { ReadingPosition } from './snapshots';

/**
 * 访问级阅读位置：根元素由页面持有，内容与展开状态还原后按稳定锚点定位；
 * 卸载前保存本次访问的位置。页面只负责自己的读取状态与快照内容。
 */
export function useVisitPosition(
  root: Ref<HTMLElement | null>,
  position: ReadingPosition | null,
  save: (position: ReadingPosition) => void,
  onUserInteraction?: () => void,
): void {
  let stopRestoring: () => void = () => undefined;

  onMounted(() => {
    stopRestoring = restoreReadingPosition(root.value, position, onUserInteraction);
  });
  onBeforeUnmount(() => {
    stopRestoring();
    save(captureReadingPosition(root.value));
  });
}
