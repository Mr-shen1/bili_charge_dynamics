<script setup lang="ts">
import { computed, reactive } from 'vue';
import { ElImage } from 'element-plus';
import type { ImageGroup } from '../demo/fixtures';
import { thumbnailPlaceholder } from '../preview/imageStatus';
import { tileId, useImagePreview } from '../preview/useImagePreview';

const props = defineProps<{ group: ImageGroup; displayLimit: number }>();
const preview = useImagePreview();
const attempts = reactive<Record<string, number>>({});
const failed = reactive<Record<string, boolean>>({});

const visible = computed(() => props.group.images.slice(0, props.displayLimit));
const hidden = computed(() => Math.max(0, props.group.images.length - visible.value.length));

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
  <div class="image-grid" :class="`image-grid--${group.owner}`" role="group" :aria-label="group.label">
    <div v-for="(image, index) in visible" :key="image.id" class="image-grid__tile">
      <button
        :id="tileId(group, index)"
        type="button"
        class="image-grid__trigger"
        :aria-label="`预览${group.label}图片 ${index + 1}`"
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
