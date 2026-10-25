<script setup lang="ts">
import { computed } from 'vue';
import type { Comment, ImageOwner } from '../data/contracts';
import type { ReplySnapshot } from '../app/snapshots';
import DynamicImages from '../preview/DynamicImages.vue';
import { useArchiveNavigation } from '../app/navigation';
import { useSession } from '../app/session';
import { displayCount, displayTime } from './display';
import FoldableText from './FoldableText.vue';
import ReadOnlyLike from './ReadOnlyLike.vue';
import ReplyPreview from './ReplyPreview.vue';
import ReplySection from './ReplySection.vue';
import UserAvatar from './UserAvatar.vue';

/** 缩略图最多展示的张数：只裁剪展示数量，完整组仍可从末张进入预览。 */
const imageDisplayLimit = 9;

const props = defineProps<{
  comment: Comment;
  authorId: string;
  dynamicId: string;
  /** 窄屏只给 UP 摘要/数量入口，回复在独立楼中楼页读取。 */
  compact: boolean;
  expanded: boolean;
  reply?: ReplySnapshot;
}>();
const emit = defineEmits<{ toggle: []; reply: [ReplySnapshot] }>();

const { reader } = useSession();
const navigation = useArchiveNavigation();
const hasText = computed(() => Boolean(props.comment.text.trim()));
// 纯图评论不写“暂无评论内容”：图片由独立的评论图片区域承载。
const hasMedia = computed(() => Boolean(props.comment.images?.length || props.comment.pendingMediaCount));
// 每条根评论自成一组：组 ID 由评论 ID 组成，动态图与其他评论的图不会串位。
const imageOwner = computed<ImageOwner>(() => ({ type: 'comment', id: props.comment.id }));
const isUpAuthor = computed(() => props.comment.author.id === props.authorId);
// 一级评论明确为 0 条来源回复时不建回复区；未知（null）仍可读取本地归档。
const hasReplies = computed(() => props.comment.replyCount === null || props.comment.replyCount > 0);
const repliesUnarchived = computed(() => reader.replies === 'not-archived');

function openThread(): void {
  navigation.openThread(props.dynamicId, props.comment.id);
}
</script>

<template>
  <li class="comment" :data-reading-id="`comment:${comment.id}`">
    <div class="comment__identity">
      <UserAvatar :user="comment.author" :size="40" class="comment__avatar" />
    </div>
    <div class="comment__body">
      <div class="comment__meta">
        <span class="comment__nickname">{{ comment.author.nickname ?? '未知用户' }}</span>
        <span v-if="isUpAuthor" class="comment__badge comment__badge--up">UP主</span>
        <span v-if="comment.isPinned" class="comment__badge">置顶</span>
      </div>
      <FoldableText
        v-if="hasText || !hasMedia"
        :text="hasText ? comment.text : '暂无评论内容'"
        subject="评论"
        :expanded="expanded"
        @toggle="emit('toggle')"
      />
      <DynamicImages
        v-if="comment.images?.length"
        :owner="imageOwner"
        :images="comment.images"
        :display-limit="imageDisplayLimit"
      />
      <p v-if="comment.pendingMediaCount" class="comment__pending" role="status">
        评论图片待归档（{{ comment.pendingMediaCount }} 张）。
      </p>
      <div class="comment__metrics">
        <time class="comment__time" :datetime="comment.publishedAt ?? undefined">
          {{ displayTime(comment.publishedAt) }}
        </time>
        <ReadOnlyLike :count="comment.likeCount" />
        <span class="comment__replies">回复 {{ displayCount(comment.replyCount) }}</span>
      </div>
      <template v-if="hasReplies">
        <p v-if="repliesUnarchived" class="comment__reply-notice" role="status">回复尚未归档。</p>
        <ReplyPreview
          v-else-if="compact"
          :up-reply="comment.upReply ?? null"
          :author-id="authorId"
          :reply-count="comment.replyCount ?? 0"
          @open="openThread"
        />
        <ReplySection
          v-else-if="!compact"
          :dynamic-id="dynamicId"
          :root-id="comment.id"
          :author-id="authorId"
          :initial="reply"
          @update="emit('reply', $event)"
        />
      </template>
    </div>
  </li>
</template>

<style scoped>
.comment {
  display: flex;
  gap: 12px;
  min-width: 0;
  padding: 14px 0;
  border-top: 1px solid var(--line);
}
.comment__identity {
  display: flex;
  flex: 0 0 40px;
  align-items: flex-start;
  min-width: 0;
}
.comment__avatar {
  flex: 0 0 40px;
}
/* 昵称与标记放在正文上方，长昵称不会在 40px 头像列里逐字换行。 */
.comment__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.comment__nickname {
  color: var(--author);
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.comment__badge {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--brand-soft, #e6f6f7);
  color: var(--brand-strong);
  font-size: 12px;
  line-height: 20px;
  white-space: nowrap;
}
.comment__badge--up {
  background: #fdebf3;
  color: var(--author);
}
.comment__body {
  flex: 1 1 auto;
  min-width: 0;
}
.comment__body :deep(.text) {
  margin-top: 0;
  font-size: 15px;
  line-height: 24px;
}
.comment__pending {
  margin: 4px 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.comment__reply-notice {
  margin: 4px 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.comment__metrics {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin-top: 4px;
  color: var(--muted);
  font-size: 13px;
  line-height: 24px;
}
.comment__time {
  overflow-wrap: anywhere;
}
</style>
