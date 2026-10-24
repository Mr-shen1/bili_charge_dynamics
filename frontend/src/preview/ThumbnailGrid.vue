<script setup lang="ts">
import { computed, reactive } from 'vue';
import { ElImage } from 'element-plus';
import type { ImageGroup } from './types';
import { thumbnailPlaceholder } from '../preview/imageStatus';
import { tileId, useImagePreview } from '../preview/useImagePreview';

const props = defineProps<{ group: ImageGroup; displayLimit: number }>();
const preview = useImagePreview();
const attempts = reactive<Record<string, number>>({});
const failed = reactive<Record<string, boolean>>({});

const visible = computed(() => props.group.images.slice(0, props.displayLimit));
const hidden = computed(() => Math.max(0, props.group.images.length - visible.value.length));
// 数量只影响栅格列宽，不是数据裁剪：完整组仍可经预览访问。
const gridLayout = computed(() => {
  const total = props.group.images.length;
  if (total === 1) return 'image-grid--single';
  if (total === 2 || total === 4) return 'image-grid--two-column';
  return '';
});

function tileLabel(index: number): string {
  // 末张兼作完整组入口：无地址提示与剩余数量都通过可访问名称表达。
  if (index === visible.value.length - 1 && hidden.value > 0) {
    return `预览${props.group.label} ${index + 1}，共 ${props.group.images.length} 张`;
  }
  return `预览${props.group.label} ${index + 1}`;
}

function open(index: number): void {
  const trigger = document.getElementById(tileId(props.group, index));
  if (trigger) preview.open(props.group.id, index, trigger);
}

function retryThumbnail(imageId: string): void {
  attempts[imageId] = (attempts[imageId] ?? 0) + 1;
  failed[imageId] = false;
}
</script>

<template>
  <div
    class="image-grid"
    :class="[`image-grid--${group.owner}`, gridLayout]"
    role="group"
    :aria-label="group.label"
    :data-image-group="group.id"
  >
    <div v-for="(image, index) in visible" :key="image.id" class="image-grid__tile">
      <button
        :id="tileId(group, index)"
        type="button"
        class="image-grid__trigger"
        :aria-label="tileLabel(index)"
        @click="open(index)"
      >
        <el-image
          v-if="image.thumbnailUrl && !failed[image.id]"
          :key="attempts[image.id] ?? 0"
          class="image-grid__thumb"
          :src="image.thumbnailUrl"
          fit="cover"
          lazy
          @error="failed[image.id] = true"
        />
        <span v-else class="image-grid__placeholder">{{ thumbnailPlaceholder(image.status) }}</span>
        <span v-if="index === visible.length - 1 && hidden > 0" class="image-grid__remaining">+{{ hidden }}</span>
      </button>
      <button v-if="failed[image.id]" type="button" class="image-grid__retry" @click="retryThumbnail(image.id)">
        重试缩略图
      </button>
    </div>
  </div>
</template>
