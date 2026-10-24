<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { Dynamic } from '../data/contracts';
import { useSession } from '../app/session';
import { useArchiveNavigation } from '../app/navigation';
import { useVisitPosition } from '../app/useVisitPosition';
import { useDetailRead } from './useDetailRead';
import DynamicContent from './DynamicContent.vue';
import ReadNotice from './ReadNotice.vue';

const props = defineProps<{ dynamicId: string }>();
const { reader } = useSession();
const navigation = useArchiveNavigation();
// 访问身份在 setup 时固定：卸载时仍按本次访问保存，不受已经切换的路由影响。
const pageEntryId = navigation.pageEntryId;
const initial = navigation.detailSnapshot;
const content = shallowRef<Dynamic | null>(initial?.dynamic ?? null);
const { state, retry } = useDetailRead(reader, props.dynamicId, initial?.dynamic ?? null);
const noticeStatus = computed(() => state.value.status === 'not-found' ? null : state.value.status);
const root = ref<HTMLElement | null>(null);
// 主动入口没有快照，定位到顶部；历史恢复才按稳定锚点返回原位置。
useVisitPosition(root, initial?.position ?? null, position => {
  navigation.saveDetailSnapshot(pageEntryId, { dynamic: content.value, position });
});

watch(state, value => {
  if (value.status === 'success' && value.data) content.value = value.data;
});
</script>

<template>
  <div ref="root" class="detail-visit">
    <el-button class="detail-back" text aria-label="返回列表" @click="navigation.returnToList()">← 返回列表</el-button>
    <h1 class="detail-title">动态详情</h1>
    <ReadNotice v-if="noticeStatus" :status="noticeStatus" area="动态详情" @retry="retry" />
    <p v-if="state.status === 'not-found'" class="detail-notice" role="status">动态不存在或不可用</p>
    <article
      v-if="state.status === 'success' && state.data"
      class="detail-card"
      :data-reading-id="`dynamic:${dynamicId}`"
    >
      <DynamicContent :dynamic="state.data" :comment-entry="false" />
    </article>
  </div>
</template>

<style scoped>
.detail-visit {
  width: 100%;
  max-width: 724px;
  min-width: 0;
  margin: 0 auto;
  padding: 0 0 40px;
}
.detail-back {
  min-height: var(--touch);
  padding: 0 4px;
  color: var(--brand-strong);
}
.detail-title {
  margin: 4px 0 12px;
  font-size: 22px;
  line-height: 30px;
}
.detail-notice {
  padding: 12px 16px;
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
}
.detail-card {
  min-width: 0;
  padding: 20px 20px 4px;
  background: var(--card-bg);
  border-radius: var(--radius);
}
@media (max-width: 480px) {
  .detail-card {
    padding: 16px 12px 4px;
  }
}
</style>
