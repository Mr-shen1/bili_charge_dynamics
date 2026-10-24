<script setup lang="ts">
import { computed } from 'vue';
import type { Dynamic, ImageOwner } from '../data/contracts';
import { displayCount, displayTime } from './display';
import DynamicImages from '../preview/DynamicImages.vue';
import FoldableText from './FoldableText.vue';
import UserAvatar from './UserAvatar.vue';

const props = withDefaults(defineProps<{
  dynamic: Dynamic;
  folding?: { expanded: boolean; toggle(): void };
  /** 详情正文不重复评论入口：计数由评论区负责。 */
  commentEntry?: boolean;
  /** 列表只展示前若干张缩略图，完整组仍可从预览访问；详情不传则全部展示。 */
  imageDisplayLimit?: number;
}>(), { commentEntry: true });
const emit = defineEmits<{ comments: [] }>();

const archive = computed(() => props.dynamic.archive);
const owner = computed<ImageOwner>(() => ({ type: 'dynamic', id: props.dynamic.id }));
// 纯图动态不伪装“暂无内容”；只有可信成功且确实没有图文时才提示空正文。
const hasMedia = computed(() => Boolean(props.dynamic.images?.length || archive.value?.mediaSources.length));
const emptyContent = computed(() =>
  !hasMedia.value && (!archive.value || archive.value.contentState === 'success') ? '暂无内容' : '');
const text = computed(() => props.dynamic.text.trim() ? props.dynamic.text : emptyContent.value);
const commentLabel = computed(() =>
  `${archive.value ? '来源评论' : '评论'} ${displayCount(props.dynamic.commentCount)}`);
</script>

<template>
  <header class="dynamic-header">
    <div class="identity" data-display-identity>
      <UserAvatar :user="dynamic.author" class="identity__avatar" />
      <div class="identity__details">
        <span class="nickname">{{ dynamic.author.nickname ?? '未知用户' }}</span>
        <time class="time" :datetime="dynamic.publishedAt ?? undefined">{{ displayTime(dynamic.publishedAt) }}</time>
      </div>
    </div>
  </header>
  <div class="dynamic-body">
    <h2 v-if="archive?.title" class="dynamic-title">{{ archive.title }}</h2>
    <FoldableText v-if="text && folding" :text="text" :expanded="folding.expanded" @toggle="folding.toggle" />
    <p v-else-if="text" class="text">{{ text }}</p>
    <DynamicImages
      v-if="dynamic.images?.length"
      :owner="owner"
      :images="dynamic.images"
      :display-limit="imageDisplayLimit"
    />
    <button
      v-if="commentEntry"
      class="comment-entry"
      type="button"
      :aria-label="commentLabel"
      @click="emit('comments')"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"
        stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
        <path d="M21 11c0 4.4-4 8-9 8H9l-4 3v-5C3.1 15.5 2 13.4 2 11c0-4.4 4.3-8 9.5-8S21 6.6 21 11Z" />
      </svg>
      <span aria-hidden="true">{{ displayCount(dynamic.commentCount) }}</span>
    </button>
  </div>
</template>

<style scoped>
.dynamic-header {
  margin-bottom: 8px;
  min-width: 0;
}
.identity {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  min-width: 0;
  cursor: default;
}
.identity__avatar {
  flex: 0 0 48px;
  width: 48px;
  height: 48px;
}
.identity__details {
  min-width: 0;
}
.nickname {
  display: block;
  min-width: 0;
  color: var(--author);
  font-size: 18px;
  line-height: 22px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.time {
  display: block;
  margin-top: 6px;
  color: var(--muted);
  font-size: 13px;
  line-height: 18px;
}
.dynamic-body {
  margin-left: 68px;
  min-width: 0;
}
.dynamic-title {
  margin: 8px 0;
  font-size: 17px;
  line-height: 25px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 25px;
  font-size: 16px;
  font-weight: 400;
  margin: 8px 0;
  min-width: 0;
}
.comment-entry {
  position: relative;
  left: -34px;
  display: flex;
  align-items: center;
  gap: 5px;
  width: max-content;
  min-height: var(--touch);
  min-width: var(--touch);
  margin: 4px auto 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.comment-entry:hover {
  color: var(--brand);
}
.comment-entry:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
@media (max-width: 480px) {
  .identity {
    gap: 12px;
  }
  .nickname {
    font-size: 16px;
  }
  .dynamic-body {
    margin-left: 60px;
  }
  .comment-entry {
    left: -30px;
  }
}
</style>
