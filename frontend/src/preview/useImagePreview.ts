import { computed, inject, nextTick, provide, ref, shallowRef, watch, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { ArchiveNavigation } from '../app/navigation';
import { createUuid } from '../app/ids';
import type { PreviewMarker } from '../app/historyState';
import { validatePreviewMarker } from './marker';
import type { ImageGroup, PreviewImage } from './types';

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
  /**
   * 注册页面读取到的图片组（合并，不整表替换）：历史前进使页面重新挂载时，
   * 已经读到的完整组仍能解析历史记录里的预览标记；会话内组数量由已读内容限定。
   */
  registerGroups(groups: readonly ImageGroup[]): void;
}

const coordinatorKey: InjectionKey<ImagePreviewCoordinator> = Symbol('image-preview-coordinator');
const fallbackFocusSelector = '[data-preview-fallback-focus]';

/**
 * 图片预览只保留组、索引与手势；历史记录、关闭来源、焦点与滚动恢复仍由
 * 应用导航协调器决定，预览自己不重复写入或校验历史元数据。
 */
export function createImagePreviewCoordinator(navigation: ArchiveNavigation): ImagePreviewCoordinator {
  const sessionId = navigation.sessionId;
  const groupsById = shallowRef(new Map<string, ImageGroup>());

  function registerGroups(groups: readonly ImageGroup[]): void {
    if (!groups.length) return;
    const next = new Map(groupsById.value);
    for (const group of groups) next.set(group.id, group);
    groupsById.value = next;
  }
  const retryGeneration = ref(0);
  /** 仅内存：触发元素与滚动位置，不写入历史记录。 */
  const memory = new Map<string, { trigger: HTMLElement; triggerId: string; scrollY: number }>();
  let closing = false;
  let clearing = false;
  /** 同步门闩：marker 依赖异步 history 同步，双击/连点必须在 push 前就拦住。 */
  let opening = false;
  let writes: Promise<unknown> = Promise.resolve();

  const state = navigation.previewState;
  const marker = computed(() => validatePreviewMarker(
    state.value.marker, sessionId, groupId => groupsById.value.get(groupId)?.images.length));
  const group = computed(() => (marker.value ? groupsById.value.get(marker.value.groupId) : undefined));

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

  async function restore(previewId: string): Promise<void> {
    const saved = memory.get(previewId);
    await nextTick();
    // 页面重新挂载后旧引用已断开：按稳定缩略图 ID 找回新节点，仍不可用才退到页面后备焦点。
    const current = saved?.trigger.isConnected ? saved.trigger
      : saved ? document.getElementById(saved.triggerId) : null;
    const focusTarget = current ?? document.querySelector<HTMLElement>(fallbackFocusSelector);
    focusTarget?.focus({ preventScroll: true });
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
  // 必须等初次导航完成再 replace：否则会与启动导航互斥，留下空 RouterView 或未清理的旧标记。
  function clearInvalidMarker(): void {
    if (!state.value.present || marker.value || clearing) return;
    clearing = true;
    void navigation.replacePreview(null)
      .catch(() => undefined)
      .finally(() => { clearing = false; });
  }

  watch(state, clearInvalidMarker, { immediate: true });

  function open(groupId: string, index: number, trigger: HTMLElement): void {
    if (marker.value || opening) return;
    const target = groupsById.value.get(groupId);
    if (!target || !target.images[index]) return;
    const previewId = createUuid();
    memory.set(previewId, { trigger, triggerId: trigger.id, scrollY: window.scrollY });
    opening = true;
    void navigation.openPreview({ previewId, groupId, index }).catch(() => undefined).finally(() => {
      // marker 已经同步时由 watch 统一放开；这里只兜住被拒绝或被取消的打开。
      if (!marker.value) opening = false;
    });
  }

  function close(): void {
    // 同一预览只后退一次；后退到位后标记消失才允许下一次关闭。
    if (!marker.value || closing) return;
    closing = true;
    navigation.back();
  }

  function persist(next: PreviewMarker): void {
    writes = writes.then(async () => {
      const current = marker.value;
      if (!current || current.previewId !== next.previewId || current.index === next.index) return;
      await navigation.replacePreview({
        previewId: next.previewId, groupId: next.groupId, index: next.index,
      });
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

  return { session, retryGeneration, open, close, switchTo, retry, imageAt, registerGroups };
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
