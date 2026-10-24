<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElButton, ElImageViewer } from 'element-plus';
import { isRetryable, statusMessage } from './imageStatus';
import { useCompactViewport } from './useCompactViewport';
import { useImagePreview } from './useImagePreview';
import type { ImageStatus } from '../demo/fixtures';

const swipeThreshold = 50;
const horizontalDominance = 1.5;
const tapTolerance = 12;
const doubleTapDelay = 300;
const tapZoomScale = 2.5;
const minScale = 0.2;
const maxScale = 7;
const unitScale = 1.01;

const preview = useImagePreview();
const session = preview.session;
const compact = useCompactViewport();
const urls = computed(() => session.value?.urls ?? []);
const viewerKey = computed(() => (session.value ? `${session.value.previewId}:${preview.retryGeneration.value}` : 'idle'));

const viewer = ref<InstanceType<typeof ElImageViewer> | null>(null);
// 窄屏的缩放完全由应用控制（库的图标工具栏在窄屏隐藏），避免与库内部 transform 抢状态。
const scale = ref(1);
const activeIndex = ref(0);

interface Gesture {
  readonly mode: 'pending' | 'pinch';
  readonly startX: number;
  readonly startY: number;
  readonly startScale: number;
  readonly startDistance: number;
}

let gesture: Gesture | null = null;
let lastTapAt: number | null = null;
/**
 * 库没有公开的 transform 复位方法；这里通过公开 toolbar slot 拿到 reset（contain↔original），
 * 调用两次即可同步清掉 offset/deg，模式最终仍为 contain。
 */
let resetLibraryTransform: (() => void) | null = null;

function captureReset(reset: () => void): string {
  resetLibraryTransform = reset;
  return '';
}

watch(() => session.value?.previewId, () => {
  activeIndex.value = session.value?.index ?? 0;
  scale.value = 1;
}, { immediate: true });

function statusOf(index: number): ImageStatus {
  return preview.imageAt(index)?.status ?? 'broken';
}

function step(offset: number): void {
  const total = urls.value.length;
  if (!total) return;
  const next = Math.min(total - 1, Math.max(0, activeIndex.value + offset));
  if (next === activeIndex.value) return;
  activeIndex.value = next;
  // 切图复位缩放，不把上一张的倍率带到下一张。
  scale.value = 1;
  viewer.value?.setActiveItem(next);
}

function onSwitch(index: number): void {
  activeIndex.value = index;
  preview.switchTo(index);
}

function isImageTarget(event: Event): boolean {
  return event.target instanceof Element && event.target.tagName === 'IMG';
}

/** 回到原始比例：缩放归 1，并清掉库内部的平移/旋转偏移。 */
async function restoreOriginal(): Promise<void> {
  scale.value = 1;
  await nextTick();
  resetLibraryTransform?.();
  resetLibraryTransform?.();
}

/** 双击：未放大时放大到固定倍率，已放大时回到原始比例。 */
async function toggleTapZoom(): Promise<void> {
  if (scale.value > unitScale) {
    await restoreOriginal();
    return;
  }
  scale.value = tapZoomScale;
}

function registerTap(): void {
  const now = Date.now();
  if (lastTapAt !== null && now - lastTapAt <= doubleTapDelay) {
    lastTapAt = null;
    void toggleTapZoom();
    return;
  }
  lastTapAt = now;
}

function touchDistance(touches: TouchList): number {
  const first = touches[0];
  const second = touches[1];
  if (!first || !second) return 0;
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function onTouchStart(event: TouchEvent): void {
  if (!compact.value || !session.value) return;
  if (event.touches.length >= 2) {
    gesture = { mode: 'pinch', startX: 0, startY: 0, startScale: scale.value, startDistance: touchDistance(event.touches) };
    // 双指只用于缩放图片，不让 Safari 缩放整个页面。
    event.preventDefault();
    return;
  }
  const touch = event.touches[0];
  if (!touch) return;
  gesture = { mode: 'pending', startX: touch.clientX, startY: touch.clientY, startScale: scale.value, startDistance: 0 };
  // 未放大时图片应固定：拦掉库的拖动，单指只用于左右滑动切图。
  if (isImageTarget(event) && scale.value <= unitScale) event.stopPropagation();
}

function onTouchMove(event: TouchEvent): void {
  const current = gesture;
  if (!compact.value || !current || current.mode !== 'pinch' || event.touches.length < 2) return;
  event.preventDefault();
  const distance = touchDistance(event.touches);
  if (!current.startDistance || !distance) return;
  const ratio = distance / current.startDistance;
  scale.value = Math.min(maxScale, Math.max(minScale, Number((current.startScale * ratio).toFixed(3))));
}

function onTouchEnd(event: TouchEvent): void {
  const current = gesture;
  gesture = null;
  if (!compact.value || !session.value) return;
  const touch = event.changedTouches[0];
  // 阻止 Safari 的双击缩放：图片上的触摸由应用接管。
  if (isImageTarget(event)) event.preventDefault();
  if (!current || !touch) return;
  if (current.mode === 'pinch') {
    // 缩到原始尺寸以下时归位并清偏移，避免图片停在画面外。
    if (scale.value <= unitScale) void restoreOriginal();
    return;
  }
  const dx = touch.clientX - current.startX;
  const dy = touch.clientY - current.startY;
  const tap = Math.abs(dx) < tapTolerance && Math.abs(dy) < tapTolerance;
  if (scale.value > unitScale) {
    // 放大后单指用于拖动阅读，只有点按才计入双击。
    if (tap) registerTap();
    return;
  }
  if (Math.abs(dx) >= swipeThreshold && Math.abs(dx) >= Math.abs(dy) * horizontalDominance) {
    lastTapAt = null;
    step(dx < 0 ? 1 : -1);
    return;
  }
  if (tap) registerTap();
}

function noop(): void {
  // gesturestart 只需要 preventDefault 阻止 Safari 页面缩放。
}
</script>

<template>
  <div
    class="preview-surface"
    @touchstart.capture="onTouchStart"
    @touchmove.capture="onTouchMove"
    @touchend.capture="onTouchEnd"
    @touchcancel.capture="onTouchEnd"
    @gesturestart.prevent="noop"
  >
    <el-image-viewer
      v-if="session"
      ref="viewer"
      :key="viewerKey"
      :url-list="urls"
      :initial-index="session.index"
      :teleported="false"
      :infinite="false"
      :scale="scale"
      :hide-on-click-modal="false"
      :close-on-press-escape="true"
      @close="preview.close()"
      @switch="onSwitch"
    >
      <template v-if="compact" #toolbar="{ reset }">
        {{ captureReset(reset) }}
      </template>
      <template #progress="{ activeIndex: current, total }">
        <span class="preview-counter" aria-live="polite">{{ current + 1 }} / {{ total }}</span>
      </template>
      <template #viewer-error="{ activeIndex: current }">
        <div class="preview-error" role="alert">
          <p>{{ statusMessage(statusOf(current)) }}</p>
          <el-button
            v-if="isRetryable(statusOf(current))"
            size="small"
            type="primary"
            @click="preview.retry()"
          >
            重试
          </el-button>
        </div>
      </template>
    </el-image-viewer>
  </div>
</template>
