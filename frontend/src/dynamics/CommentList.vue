<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { ArchiveMetadata, CommentSort } from '../data/contracts';
import type { CommentSnapshot } from '../app/snapshots';
import { useSession } from '../app/session';
import { useCommentsRead } from './useCommentsRead';
import CommentItem from './CommentItem.vue';
import ReadNotice from './ReadNotice.vue';

const props = defineProps<{
  dynamicId: string;
  authorId: string;
  sort: CommentSort;
  archive?: ArchiveMetadata;
  initial: CommentSnapshot;
}>();
const emit = defineEmits<{ update: [CommentSnapshot]; settled: []; restart: [] }>();

const { reader } = useSession();
const { state, load } = useCommentsRead(
  reader, { dynamicId: props.dynamicId, sort: props.sort }, props.initial.read);
const expanded = ref<Record<string, boolean>>({ ...props.initial.expanded });
const area = computed(() => props.sort === 'hot' ? '最热评论' : '最新评论');
// 成功空只在归档确认本轮根评论同步完成后才是“暂无评论”，否则不冒充来源没有评论。
const emptyUnarchived = computed(() => Boolean(props.archive
  && (props.archive.rootCommentsLastAttempt ?? props.archive.work.comments) !== 'success'));

function toggle(id: string): void {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
}

watch([state, expanded], () => {
  emit('update', { sort: props.sort, read: state.value, expanded: { ...expanded.value } });
}, { immediate: true, flush: 'sync' });
// 首批有结果（成功或失败）后通知入口定位：布局已稳定，迟到任务也不会反复拉回。
watch(() => state.value.status, status => {
  if (status !== 'loading') emit('settled');
}, { immediate: true, flush: 'post' });
</script>

<template>
  <section v-if="state.reason === 'invalid-cursor'" class="comment-status">
    <p role="alert">评论读取标记无效，请重新开始读取。</p>
    <el-button type="primary" link class="comment-action" @click="emit('restart')">重新开始读取</el-button>
  </section>
  <p v-if="state.reason === 'not-archived'" class="comment-status" role="status">
    评论尚未归档；来源计数不代表本地已有评论。
  </p>
  <ReadNotice
    v-if="!state.data && state.reason !== 'invalid-cursor' && state.reason !== 'not-archived'"
    :status="state.status"
    :area="area"
    @retry="load()"
  />
  <p v-if="state.data && state.data.items.length === 0" class="comment-status" role="status">
    {{ emptyUnarchived ? '评论尚未归档；来源计数不代表本地已有评论。' : '暂无评论' }}
  </p>
  <ul v-if="state.data && state.data.items.length > 0" class="comment-list" aria-label="一级评论">
    <CommentItem
      v-for="item in state.data.items"
      :key="item.id"
      :comment="item"
      :author-id="authorId"
      :expanded="expanded[item.id] ?? false"
      @toggle="toggle(item.id)"
    />
  </ul>
  <section
    v-if="state.data && state.data.items.length > 0 && state.data.nextCursor !== null"
    class="comment-append"
    aria-label="评论追加"
  >
    <ReadNotice
      v-if="state.status !== 'success' && state.reason !== 'invalid-cursor'"
      :status="state.status"
      :area="`${area}追加`"
      @retry="load()"
    />
    <el-button
      v-if="state.status === 'success' || state.status === 'loading'"
      type="primary"
      class="comment-action"
      :disabled="state.status === 'loading'"
      @click="load()"
    >加载更多评论</el-button>
  </section>
</template>

<style scoped>
.comment-status {
  padding: 12px 0;
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.comment-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.comment-append {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0 4px;
}
.comment-action {
  min-height: var(--touch);
}
</style>
