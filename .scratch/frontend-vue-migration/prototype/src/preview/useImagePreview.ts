import { computed, inject, nextTick, onMounted, onUnmounted, provide, ref, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ImageGroup, PreviewImage } from '../demo/fixtures';
import { markerState, readMarker, validateMarker, type PreviewMarker } from './state';

export interface PreviewSession {
  readonly previewId: string;
  readonly groupId: string;
  readonly index: number;
  readonly images: readonly PreviewImage[];
  readonly urls: string[];
}

export interface ImagePreviewCoordinator {
  readonly session: ComputedRef<PreviewSession | null>;
  /** 重试代次：变化即重新挂载 viewer，只用于重发当前图片，不重建历史或索引。 */
  readonly retryGeneration: Ref<number>;
  open(groupId: string, index: number, trigger: HTMLElement): void;
  close(): void;
  switchTo(index: number): void;
  retry(): void;
  imageAt(index: number): PreviewImage | undefined;
}

const coordinatorKey: InjectionKey<ImagePreviewCoordinator> = Symbol('image-preview-coordinator');
const fallbackFocusSelector = '[data-preview-fallback-focus]';

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `preview-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * 唯一导航协调器：历史记录、关闭来源、焦点与滚动恢复都在这里决定。
 * 预览、切图与重试不重写库的缩放/旋转/手势引擎，只同步索引与历史元数据。
 */
export function createImagePreviewCoordinator(groups: readonly ImageGroup[]): ImagePreviewCoordinator {
  const route = useRoute();
  const router = useRouter();
  const sessionId = randomId();
  const groupsById = new Map(groups.map(group => [group.id, group]));
  const retryGeneration = ref(0);
  /** 仅内存：触发元素与滚动位置，不写入历史记录。 */
  const memory = new Map<string, { triggerId: string; scrollY: number }>();
  let closing = false;
  let clearing = false;
  /** 同步门闩：marker 依赖异步 history 同步，双击/连点必须在 push 前就拦住。 */
  let opening = false;
  let writes: Promise<unknown> = Promise.resolve();

  // 直接读取浏览器历史记录的 state：标记由本协调器写入，Vue Router 的自有字段保持原样。
  const historyState = ref<unknown>(window.history.state);
  const syncState = (): void => { historyState.value = window.history.state; };
  const stopAfterEach = router.afterEach(syncState);
  onMounted(() => window.addEventListener('popstate', syncState));
  onUnmounted(() => {
    stopAfterEach();
    window.removeEventListener('popstate', syncState);
  });

  const state = computed(() => readMarker(historyState.value));
  const marker = computed(() => validateMarker(state.value.marker, sessionId, groupId => groupsById.get(groupId)?.images.length));
  const group = computed(() => (marker.value ? groupsById.get(marker.value.groupId) : undefined));

  const session = computed<PreviewSession | null>(() => {
    const current = marker.value;
    const currentGroup = group.value;
    if (!current || !currentGroup) return null;
    return {
      previewId: current.previewId,
      groupId: current.groupId,
      index: current.index,
      images: currentGroup.images,
      urls: currentGroup.images.map(image => image.previewUrl),
    };
  });

  const location = () => ({ path: route.path, query: route.query, hash: route.hash }) as const;

  async function restore(previewId: string): Promise<void> {
    const saved = memory.get(previewId);
    await nextTick();
    const trigger = saved ? document.getElementById(saved.triggerId) : null;
    const fallback = document.querySelector<HTMLElement>(fallbackFocusSelector);
    // 触发器已消失时退到页面的后备焦点，不把焦点丢回 body 或浏览器地址栏。
    (trigger?.isConnected ? trigger : fallback)?.focus({ preventScroll: true });
    if (saved) window.scrollTo({ top: saved.scrollY, left: 0, behavior: 'instant' });
  }

  watch(marker, (value, previous) => {
    if (value) {
      opening = false;
      // 每次新预览从第一次尝试开始；同一预览的索引同步不重置。
      if (!previous || previous.previewId !== value.previewId) retryGeneration.value = 0;
      return;
    }
    closing = false;
    opening = false;
    if (previous) void restore(previous.previewId);
  });

  // 失效或损坏的标记（刷新后会话失效、组或索引不存在）只清理标记，不假装打开预览。
  watch(state, () => {
    if (!state.value.present || marker.value || clearing) return;
    clearing = true;
    void router
      .replace({ ...location(), force: true, state: markerState(null) })
      .catch(() => undefined)
      .finally(() => { clearing = false; });
  }, { immediate: true });

  function open(groupId: string, index: number, trigger: HTMLElement): void {
    if (marker.value || opening) return;
    const target = groupsById.get(groupId);
    if (!target || !target.images[index]) return;
    const previewId = randomId();
    memory.set(previewId, { triggerId: trigger.id, scrollY: window.scrollY });
    opening = true;
    void router.push({
      ...location(), force: true,
      state: markerState({ sessionId, previewId, groupId, index }),
    }).catch(() => undefined).finally(() => {
      // marker 已经同步时由 watch 统一放开；这里只兜住被拒绝或被取消的打开。
      if (!marker.value) opening = false;
    });
  }

  function close(): void {
    // 同一预览只后退一次；后退到位后标记消失才允许下一次关闭。
    if (!marker.value || closing) return;
    closing = true;
    void router.go(-1);
  }

  function persist(next: PreviewMarker): void {
    writes = writes.then(async () => {
      const current = marker.value;
      if (!current || current.previewId !== next.previewId || current.index === next.index) return;
      await router.replace({ ...location(), force: true, state: markerState(next) });
    }).catch(() => undefined);
  }

  function switchTo(index: number): void {
    const current = marker.value;
    if (!current) return;
    const images = group.value?.images ?? [];
    if (index === current.index || index < 0 || index >= images.length) return;
    persist({ ...current, index });
  }

  function retry(): void {
    retryGeneration.value += 1;
  }

  // 按索引取图，不按 URL 反查：同组可能出现共用地址（含应用占位），反查会串位。
  function imageAt(index: number): PreviewImage | undefined {
    return group.value?.images[index];
  }

  return { session, retryGeneration, open, close, switchTo, retry, imageAt };
}

export function provideImagePreview(coordinator: ImagePreviewCoordinator): void {
  provide(coordinatorKey, coordinator);
}

export function useImagePreview(): ImagePreviewCoordinator {
  const coordinator = inject(coordinatorKey);
  if (!coordinator) throw new Error('图片预览协调器未装配');
  return coordinator;
}

export function tileId(group: ImageGroup, index: number): string {
  return `preview-trigger-${group.id}-${index}`;
}
