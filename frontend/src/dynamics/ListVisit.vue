<script setup lang="ts">
import { ref } from 'vue';
import { ElButton } from 'element-plus';
import type { ArchiveScope } from '../data/contracts';
import { useSession } from '../app/session';
import { useArchiveNavigation } from '../app/navigation';
import { useVisitPosition } from '../app/useVisitPosition';
import { useListRead } from './useListRead';
import ArchiveNavigation from './ArchiveNavigation.vue';
import DynamicCard from './DynamicCard.vue';
import DynamicContent from './DynamicContent.vue';
import ReadNotice from './ReadNotice.vue';

const props = defineProps<{ scope: ArchiveScope }>();
// 列表卡片最多展示九张缩略图；完整图片组仍通过预览访问。
const listThumbnailLimit = 9;
const { reader } = useSession();
const navigation = useArchiveNavigation();
// 访问身份在 setup 时固定：卸载时仍按本次访问保存，不受已经切换的路由影响。
const pageEntryId = navigation.pageEntryId;
const initial = navigation.listSnapshot;
const { state, load } = useListRead(reader, props.scope, initial?.read);
const expanded = ref<Record<string, boolean>>({ ...(initial?.expanded ?? {}) });
const root = ref<HTMLElement | null>(null);
useVisitPosition(root, initial?.position ?? null, position => {
  const read = state.value;
  navigation.saveListSnapshot(pageEntryId, {
    // 离开时仍在读取的批次按“已取消”保存，返回后可从原 cursor 继续。
    read: read.status === 'loading' ? { ...read, status: 'cancelled' } : read,
    expanded: { ...expanded.value },
    position,
  });
});

function toggle(id: string): void {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
}

function foldingFor(id: string): { expanded: boolean; toggle(): void } {
  return { expanded: expanded.value[id] ?? false, toggle: () => toggle(id) };
}
</script>

<template>
  <div ref="root" class="list-visit">
    <ArchiveNavigation :scope="scope" />
    <div v-if="state.reason === 'invalid-cursor'" class="list-notice">
      <p role="alert">分页已失效，请重新开始读取。</p>
      <el-button type="primary" link class="list-action" @click="load(true)">重新开始</el-button>
    </div>
    <p v-if="state.reason === 'unknown-up'" class="list-notice" role="status">UP 不存在</p>
    <ReadNotice
      v-else-if="!state.data && state.reason !== 'invalid-cursor'"
      :status="state.status"
      area="动态列表"
      @retry="load()"
    />
    <p v-if="state.data && state.data.items.length === 0" class="list-notice" role="status">暂无动态</p>
    <DynamicCard v-for="dynamic in state.data?.items ?? []" :key="dynamic.id" :id="dynamic.id">
      <div class="card-content">
        <DynamicContent
          :dynamic="dynamic"
          :folding="foldingFor(dynamic.id)"
          :image-display-limit="listThumbnailLimit"
          @comments="navigation.openDetail(dynamic.id, 'comments')"
        />
      </div>
    </DynamicCard>
    <template v-if="state.data && state.data.items.length > 0">
      <p v-if="state.data.nextCursor === null" class="list-notice" role="status">动态已加载完毕</p>
      <section v-else class="list-append" aria-label="动态追加">
        <ReadNotice
          v-if="state.status !== 'success' && state.reason !== 'invalid-cursor'"
          :status="state.status"
          area="动态追加"
          @retry="load()"
        />
        <el-button
          v-if="state.status === 'success' || state.status === 'loading'"
          type="primary"
          class="list-action"
          :disabled="state.status === 'loading'"
          @click="load()"
        >加载更多</el-button>
      </section>
    </template>
  </div>
</template>

<style scoped>
.list-visit {
  min-width: 0;
}
.list-notice {
  padding: 12px 16px;
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.list-append {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0 24px;
}
.list-action {
  min-height: var(--touch);
}
</style>
