<script setup lang="ts">
import { computed } from 'vue';
import { ElButton } from 'element-plus';
import type { Reply } from '../data/contracts';
import { replyBodyText } from './replyText';
import ReadOnlyLike from './ReadOnlyLike.vue';
import UserAvatar from './UserAvatar.vue';

/**
 * 窄屏一级评论的回复入口：来源回复数为正时才出现。
 * 有该动态作者在此楼最早的回复（`up_reply`）时先展示这一条，否则只留数量入口；
 * 两种情况都进入独立楼中楼页，窄屏不在详情内联读取回复。
 */
const props = defineProps<{
  upReply: Reply | null;
  authorId: string;
  replyCount: number;
}>();
const emit = defineEmits<{ open: [] }>();

const total = computed(() => (props.replyCount > 0 ? props.replyCount : 0));
const entryLabel = computed(() => `${props.upReply ? 'UP主等人 ' : ''}共${total.value}条回复`);
/** 摘要按来源给的 `replyTo` 表达目标；缺失目标时不伪造。 */
const targetNickname = computed(() => props.upReply?.replyTo?.nickname ?? null);
const bodyText = computed(() => {
  const text = replyBodyText(props.upReply?.text ?? '');
  return text.trim() ? text : '暂无评论内容';
});
</script>

<template>
  <section v-if="total > 0" class="reply-preview" aria-label="UP 回复预览">
    <div v-if="upReply" class="reply-preview__body">
      <div class="reply-preview__identity">
        <UserAvatar :user="upReply.author" :size="24" class="reply-preview__avatar" />
        <span class="reply-preview__nickname">{{ upReply.author.nickname ?? '未知用户' }}</span>
        <span v-if="upReply.author.id === authorId" class="reply-preview__badge">UP主</span>
      </div>
      <p class="reply-preview__text">
        <span v-if="targetNickname" class="reply-preview__target">回复 {{ targetNickname }}:</span>{{ bodyText }}
      </p>
      <ReadOnlyLike :count="upReply.likeCount" />
    </div>
    <el-button type="primary" link class="reply-preview__entry" @click="emit('open')">
      {{ entryLabel }}<span class="reply-preview__arrow" aria-hidden="true">›</span>
    </el-button>
  </section>
</template>

<style scoped>
.reply-preview {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
  margin-top: 6px;
  padding: 8px 10px;
  background: var(--brand-soft, #e6f6f7);
  border-radius: 8px;
}
.reply-preview__body {
  min-width: 0;
  width: 100%;
}
.reply-preview__identity {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.reply-preview__avatar {
  flex: 0 0 24px;
}
.reply-preview__nickname {
  color: var(--author);
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.reply-preview__badge {
  padding: 0 6px;
  border-radius: 999px;
  background: #fdebf3;
  color: var(--author);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}
.reply-preview__text {
  margin: 4px 0;
  font-size: 15px;
  line-height: 24px;
  overflow-wrap: anywhere;
}
.reply-preview__target {
  color: var(--brand-strong);
}
.reply-preview__entry {
  min-height: var(--touch);
  padding: 0;
  font-size: 13px;
}
.reply-preview__arrow {
  margin-left: 4px;
}
</style>
