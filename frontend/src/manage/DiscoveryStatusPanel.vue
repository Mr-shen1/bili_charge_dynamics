<script setup lang="ts">
import { computed } from 'vue';
import { ElAlert, ElButton } from 'element-plus';
import { useSession } from '../app/session';
import { displayTime } from '../dynamics/display';
import type { DiscoveryState } from './discoveryState';
import { discoveryErrorText, discoveryModeText, discoveryStatusText } from './discoveryText';
import { useStatusRead } from './useStatusRead';

/**
 * 近期发现与当前窗口：手动读取已保存状态，不启动发现、不领取工作、不轮询。
 * 本轮候选、历史可信结果与已发布窗口分开展示，发现成功也不代表内容已归档。
 */
const props = defineProps<{ uid: string }>();
const { management } = useSession();
const { data, state, error, readLabel, read } = useStatusRead<DiscoveryState>('发现状态', signal =>
  management.readDiscovery({ uid: props.uid, signal }));

const modeText = computed(() => (data.value ? discoveryModeText(data.value) : ''));
const enabledText = computed(() => (data.value?.enabled ? '已启用' : '已停止'));
</script>

<template>
  <section class="manage-section" aria-label="近期发现与当前窗口">
    <h2 class="manage-section-title">近期发现与当前窗口</h2>
    <p class="manage-muted">仅读取已保存状态，不触发发现、检查或同步；不自动轮询。</p>
    <el-button
      type="primary"
      class="manage-read"
      :aria-busy="state === 'loading'"
      @click="read()"
    >
      {{ readLabel }}
    </el-button>
    <p v-if="state === 'idle'" class="manage-muted" role="status">尚未读取发现状态。</p>
    <el-alert
      v-if="state === 'error'"
      class="manage-feedback"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <template v-if="state === 'ready' && data">
      <p class="manage-state">读取时已保存模式：{{ modeText }}；监控：{{ enabledText }}。</p>
      <p class="manage-state">{{ discoveryStatusText[data.status] }}</p>
      <p v-if="!data.active" class="manage-state">近期发现当前未启用；历史结果仍可读取。</p>
      <p v-if="data.incomplete" class="manage-state">发现未完成；保留已有可信结果与已发布窗口。</p>
      <p v-if="data.retryable" class="manage-state">可在下一固定节拍重试；页面重读不会启动发现。</p>
      <p v-if="data.active && !data.incomplete" class="manage-state">
        发现窗口已就绪；内容归档请另读检查状态。
      </p>
      <section v-if="data.attempt" class="manage-subsection" aria-label="本轮发现尝试">
        <h3 class="manage-section-title">本轮累计候选（不代表已发布）</h3>
        <p class="manage-state">本轮 N：{{ data.attempt.recentN }}；开始：{{ displayTime(data.attempt.startedAt) }}</p>
        <p class="manage-state">
          本轮完成：{{ data.attempt.finishedAt ? displayTime(data.attempt.finishedAt) : '未完成' }}
        </p>
        <ul class="manage-targets" aria-label="本轮累计候选">
          <li v-for="id in data.attempt.ids" :key="id">{{ id }}</li>
        </ul>
        <p v-if="data.attempt.error" class="manage-state-error" role="status">
          发现错误：{{ discoveryErrorText[data.attempt.error] }}
        </p>
      </section>
      <section class="manage-subsection" aria-label="最近可信发现结果">
        <h3 class="manage-section-title">最近可信发现目标（历史结果）</h3>
        <template v-if="data.trustedResult">
          <p class="manage-state">
            可信结果 N：{{ data.trustedResult.recentN }}；发现时间：{{ displayTime(data.trustedResult.discoveredAt) }}
          </p>
          <p class="manage-state">
            {{ data.trustedResult.exhausted
              ? '该轮来源已耗尽；结果保持来源次序。'
              : '该轮达到 N 后停止扫描；不保证历史已耗尽。' }}
          </p>
          <p v-if="data.trustedResult.ids.length === 0" class="manage-state">可信成功空结果；不等于发现失败。</p>
          <ul class="manage-targets" aria-label="最近可信发现目标">
            <li v-for="id in data.trustedResult.ids" :key="id">{{ id }}</li>
          </ul>
        </template>
        <p v-else class="manage-state">尚无完整成功的可信发现结果。</p>
      </section>
      <section class="manage-subsection" aria-label="当前近期窗口">
        <h3 class="manage-section-title">当前启用近期目标（已发布窗口）</h3>
        <p class="manage-muted">与历史可信发现结果分开；入选不代表归档完成。</p>
        <p v-if="data.currentIds.length === 0" class="manage-state">当前无启用的近期目标；不表示历史归档已删除。</p>
        <ul class="manage-targets" aria-label="当前启用近期目标">
          <li v-for="id in data.currentIds" :key="id">{{ id }}</li>
        </ul>
      </section>
    </template>
  </section>
</template>

<style scoped>
.manage-subsection {
  margin-top: 16px;
}

.manage-targets {
  margin: 8px 0 0;
  padding-left: 20px;
  overflow-wrap: anywhere;
}
</style>
