<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput } from 'element-plus';
import { useSession } from '../app/session';
import { combineSignals } from '../app/signals';
import { reportReadError } from '../app/readError';
import {
  invalidTargetMessage, isValidTargetId, type ManagedTarget,
} from './managementApi';
import type { ManagementRequests } from './useManagementRequests';

/**
 * 指定模式下的关联目标：读取、添加与移除都只走既有目标接口。
 * 组件随草稿模式或 UP 重建，因此上一模式的输入、反馈与读取身份不会延续；
 * 卸载时取消在途写入，不继续占用该 UP 的写入锁。
 */
const props = defineProps<{ uid: string; requests: ManagementRequests }>();
const { management } = useSession();

type Action = 'add' | 'remove';
const targets = ref<readonly ManagedTarget[]>([]);
const state = ref<'loading' | 'error' | 'ready'>('loading');
const error = ref('');
const draftTargetId = ref('');
const notice = ref<{ error: boolean; text: string; action: Action } | null>(null);
const addPending = ref(false);
const removingId = ref<string | null>(null);
const busy = computed(() => props.requests.busyUids.value.has(props.uid));
let request: AbortController | null = null;
let active = false;
const lifetime = new AbortController();

async function load(): Promise<void> {
  if (!active || request) return;
  const controller = new AbortController();
  request = controller;
  state.value = 'loading';
  try {
    const result = await management.listTargets({ uid: props.uid, signal: controller.signal });
    if (!active || controller.signal.aborted || request !== controller) return;
    request = null;
    if (result.status === 'success') {
      targets.value = result.data;
      state.value = 'ready';
    } else if (result.status === 'error') {
      error.value = result.message;
      state.value = 'error';
    }
  } catch (cause) {
    if (!active || controller.signal.aborted || request !== controller) return;
    request = null;
    reportReadError('管理配置', cause);
    error.value = '管理接口响应异常，请重试。';
    state.value = 'error';
  }
}

function editTargetId(value: string): void {
  draftTargetId.value = value;
  notice.value = null;
}

/** 与新增 UP 相同：本地只校验字符串 ID，作者归属由服务端复核。 */
async function add(): Promise<void> {
  if (busy.value || state.value !== 'ready') return;
  if (!isValidTargetId(draftTargetId.value)) {
    notice.value = { error: true, text: invalidTargetMessage, action: 'add' };
    return;
  }
  const submitted = draftTargetId.value;
  notice.value = null;
  addPending.value = true;
  const result = await props.requests.run(props.uid, signal =>
    management.addTarget({ uid: props.uid, id: submitted, signal: combineSignals(signal, lifetime.signal) }));
  addPending.value = false;
  // 已取消、离开页面或属于别的写入：迟到结果不改写当前目标区。
  if (!result) return;
  if (result.status === 'success') {
    const added = result.data;
    targets.value = targets.value.some(target => target.id === added.id) ? targets.value
      : [...targets.value, added].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    draftTargetId.value = '';
    notice.value = { error: false, text: '归属校验通过，目标关联已保存。', action: 'add' };
  } else if (result.status === 'error') {
    notice.value = { error: true, text: result.message, action: 'add' };
  }
}

/** 移除只解除关联：已保存内容不随管理操作删除。 */
async function remove(targetId: string): Promise<void> {
  if (busy.value || state.value !== 'ready') return;
  notice.value = null;
  removingId.value = targetId;
  const result = await props.requests.run(props.uid, signal =>
    management.deleteTarget({ uid: props.uid, id: targetId, signal: combineSignals(signal, lifetime.signal) }));
  removingId.value = null;
  if (!result) return;
  if (result.status === 'success') {
    targets.value = targets.value.filter(target => target.id !== targetId);
    notice.value = { error: false, text: '目标已移除；已保存的动态保留。', action: 'remove' };
  } else if (result.status === 'error') {
    notice.value = { error: true, text: result.message, action: 'remove' };
  }
}

function removeLabel(targetId: string): string {
  return removingId.value === targetId && busy.value ? '正在移除…' : '移除目标';
}

const addLabel = computed(() => {
  if (addPending.value && busy.value) return '正在校验…';
  if (notice.value?.error && notice.value.action === 'add') return '重试添加目标';
  return '校验并添加目标';
});

onMounted(() => {
  active = true;
  void load();
});
onUnmounted(() => {
  active = false;
  lifetime.abort();
  request?.abort();
  request = null;
});
</script>

<template>
  <section class="manage-section" aria-label="指定动态目标">
    <h2 class="manage-section-title">指定动态目标</h2>
    <p class="manage-muted">仅在已保存的指定模式下监控关联集合。添加前由服务端验证作者；移除仅停止监控，不删除已保存的动态。</p>
    <p v-if="state === 'loading'" class="manage-notice manage-target-notice" role="status">正在读取指定目标…</p>
    <div v-else-if="state === 'error'" class="manage-notice manage-target-notice">
      <el-alert :title="error" type="error" :closable="false" show-icon />
      <el-button class="manage-target-retry" @click="load()">重试读取目标</el-button>
    </div>
    <template v-else>
      <p v-if="targets.length === 0" class="manage-muted">尚未添加指定目标。</p>
      <ul v-else class="manage-targets" aria-label="指定动态目标列表">
        <li v-for="target in targets" :key="target.id">
          <span class="manage-target-id">{{ target.id }}</span>
          <el-button
            class="manage-target-remove"
            :disabled="busy"
            :aria-label="`移除目标 ${target.id}`"
            @click="remove(target.id)"
          >
            {{ removeLabel(target.id) }}
          </el-button>
        </li>
      </ul>
      <el-form class="manage-target-add" aria-label="添加指定目标" @submit.prevent="add">
        <fieldset class="manage-fields" :disabled="busy">
          <el-form-item label="动态 ID">
            <el-input
              :model-value="draftTargetId"
              inputmode="numeric"
              autocomplete="off"
              :disabled="busy"
              @update:model-value="editTargetId"
            />
          </el-form-item>
          <el-button type="primary" native-type="submit" class="manage-target-submit" :disabled="busy">
            {{ addLabel }}
          </el-button>
        </fieldset>
      </el-form>
    </template>
    <el-alert
      v-if="notice"
      class="manage-feedback"
      :title="notice.text"
      :type="notice.error ? 'error' : 'success'"
      :closable="false"
      show-icon
    />
  </section>
</template>

<style scoped>
.manage-target-notice {
  margin: 12px 0 0;
}

.manage-target-retry {
  margin-top: 8px;
  min-height: var(--touch);
}

.manage-targets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}

.manage-targets li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.manage-target-id {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.manage-target-remove,
.manage-target-submit {
  min-height: var(--touch);
}

.manage-target-add {
  margin-top: 12px;
}
</style>
