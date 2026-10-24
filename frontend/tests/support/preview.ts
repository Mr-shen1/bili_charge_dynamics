import { computed, defineComponent, h } from 'vue';
import type { ArchiveNavigation } from '../../src/app/navigation';
import {
  createImagePreviewCoordinator, provideImagePreview, useImagePreview,
  type ImagePreviewCoordinator,
} from '../../src/preview/useImagePreview';

/** 页面测试装配：唯一导航协调器 + 唯一预览协调器，与 App 根部一致。 */
export function providePreview(navigation: ArchiveNavigation): ImagePreviewCoordinator {
  const coordinator = createImagePreviewCoordinator(navigation);
  provideImagePreview(coordinator);
  return coordinator;
}

/** 用公开的可访问输出观察预览状态，不依赖预览层内部结构或 Element Plus DOM。 */
export const PreviewProbe = defineComponent({
  setup() {
    const preview = useImagePreview();
    const text = computed(() => {
      const session = preview.session.value;
      return session ? `${session.groupId}:${session.index}/${session.images.length}` : 'closed';
    });
    return () => h('output', { 'data-testid': 'preview-session' }, text.value);
  },
});
