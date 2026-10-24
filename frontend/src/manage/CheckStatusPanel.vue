<script setup lang="ts">
import { computed } from 'vue';
import { ElAlert, ElButton, ElCollapse, ElCollapseItem, ElTag } from 'element-plus';
import { useSession } from '../app/session';
import type { TargetCheck } from '../data/checkStatus';
import type { Monitor } from './managementApi';
import CheckStatusDetail from './CheckStatusDetail.vue';
import { checkStatusBadgeText, checkStatusBadgeType, panelCheckTimes } from './checkStatusText';
import { useStatusRead } from './useStatusRead';

/**
 * 目标检查与归档状态：手动读取已保存的持久状态，不触发检查、同步或轮询。
 * UP 级时间只说明该 UP 历史目标记录的最近值；读取后改用刚读到的记录推导，
 * 不再沿用配置读取时的旧值。
 */
const props = defineProps<{ uid: string; monitor: Monitor | null }>();
const { management } = useSession();
const { data, state, error, readLabel, read } = useStatusRead<readonly TargetCheck[]>('检查状态', signal =>
  management.listChecks({ uid: props.uid, signal }));
const checks = computed(() => data.value ?? []);
const times = computed(() => panelCheckTimes(props.monitor, data.value));
</script>

<template>
  <section class="manage-section" aria-label="目标检查与归档状态">
    <h2 class="manage-section-title">目标检查与归档状态</h2>
    <p class="manage-state">最近检查：{{ times.checked }}</p>
    <p class="manage-state">最近成功：{{ times.succeeded }}</p>
    <p class="manage-muted">以上为该 UP 历史目标记录的最近时间，不代表全部目标均已成功。</p>
    <p class="manage-muted">仅读取已保存状态，不触发检查或同步；停用后的记录仍可读取。</p>
    <p class="manage-muted">来源总数含根评论和回复；本地数是保留归档量，不是当前已加载数，也不代表全部来源评论。</p>
    <p class="manage-muted">除初始化和失败重试外，仅按来源总数变化同步评论；增删抵消、纯评论编辑或分页移动且总数不变可能漏检，不保证实时或所有受限评论可读。</p>
    <el-button
      type="primary"
      class="manage-read"
      :aria-busy="state === 'loading'"
      @click="read()"
    >
      {{ readLabel }}
    </el-button>
    <p v-if="state === 'idle'" class="manage-muted" role="status">尚未读取检查状态。</p>
    <el-alert
      v-if="state === 'error'"
      class="manage-feedback"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <p v-if="state === 'ready' && checks.length === 0" class="manage-muted">尚无目标检查记录。</p>
    <el-collapse v-if="checks.length > 0" class="manage-checks">
      <el-collapse-item v-for="check in checks" :key="check.id" :name="check.id">
        <template #title>
          <span class="manage-check-title">动态 {{ check.id }}</span>
          <el-tag size="small" :type="checkStatusBadgeType[check.checkStatus]">
            {{ checkStatusBadgeText[check.checkStatus] }}
          </el-tag>
        </template>
        <CheckStatusDetail :check="check" />
      </el-collapse-item>
    </el-collapse>
  </section>
</template>

<style scoped>
.manage-checks {
  margin-top: 12px;
  border-top: 1px solid var(--line);
  border-bottom: 0;
}

.manage-check-title {
  margin-right: 8px;
  overflow-wrap: anywhere;
}
</style>
