<script setup lang="ts">
import { ref } from 'vue';
import { ElButton } from 'element-plus';
import { useRouter } from 'vue-router';
import type { ArchiveScope } from '../data/contracts';
import { useSession } from '../app/session';
import { useListRead } from './useListRead';
import ArchiveNavigation from './ArchiveNavigation.vue';
import DynamicCard from './DynamicCard.vue';
import DynamicContent from './DynamicContent.vue';
import ReadNotice from './ReadNotice.vue';

const props = defineProps<{ scope: ArchiveScope }>();
const router = useRouter();
const { reader } = useSession();
const { state, load } = useListRead(reader, props.scope);
// 展开状态跟随本次访问；03 会把它并入访问快照，不与内容实体混用。
const expanded = ref<Record<string, boolean>>({});

function toggle(id: string): void {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
}

function foldingFor(id: string): { expanded: boolean; toggle(): void } {
  return { expanded: expanded.value[id] ?? false, toggle: () => toggle(id) };
}

function openDetail(id: string): void {
  void router.push({ name: 'detail', params: { dynamicId: id } });
}
</script>

<template>
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
        @comments="openDetail(dynamic.id)"
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
</template>

<style scoped>
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
