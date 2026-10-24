<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElRadio, ElRadioGroup } from 'element-plus';
import UserAvatar from '../dynamics/UserAvatar.vue';
import { useSession } from '../app/session';
import type { ManagedUp, ManagementResult, MonitorConfig } from './managementApi';
import { manageStatus, manageUser } from './status';
import type { ManagementRequests } from './useManagementRequests';
import ManageTargets from './ManageTargets.vue';

/**
 * 单 UP 身份卡：启停总是提交已保存配置，模式与近期 N 是独立草稿，只由「保存配置」提交。
 * 指定目标区随草稿模式出现，因此切换模式会卸载上一模式的输入与反馈。
 */
const props = defineProps<{ up: ManagedUp; requests: ManagementRequests }>();
const emit = defineEmits<{ change: [up: ManagedUp] }>();
const { management } = useSession();

type Action = 'save' | 'toggle' | 'delete' | 'add';
const invalidRecentNMessage = '近期 N 须为正的安全整数，最大 9007199254740991。';

const user = computed(() => manageUser(props.up));
const status = computed(() => manageStatus(props.up));
const busy = computed(() => props.requests.busyUids.value.has(props.up.uid));
const mode = ref<MonitorConfig['mode']>(props.up.monitor?.mode ?? 'recent');
const recentN = ref(String(props.up.monitor?.recentN ?? 10));
const notice = ref<{ error: boolean; text: string; action: Action } | null>(null);
const pending = ref<Action | null>(null);

const monitorText = computed(() => {
  if (!props.up.monitor) return '无配置';
  return props.up.monitor.enabled ? '已启用' : '已停止';
});
const savedModeText = computed(() => {
  const monitor = props.up.monitor;
  if (!monitor) return '';
  return monitor.mode === 'recent' ? `已保存模式：近期 N 条；N：${monitor.recentN}。` : '已保存模式：指定动态 ID。';
});
const targetHint = computed(() => {
  if (!props.up.monitor) return '配置已删除，不再监控目标。';
  return '近期模式按已保存的 N 值监控；切换指定模式可管理关联目标。';
});
const verb = computed(() => (props.up.monitor?.enabled ? '停止' : '启用'));

/** 同一 UP 的四个写入共用同一条反馈路径：在途、失败重试与成功提示只按动作区分。 */
function labelFor(action: Action, idle: string, running: string, retry: string): string {
  if (pending.value === action && busy.value) return running;
  if (notice.value?.error && notice.value.action === action) return retry;
  return idle;
}

const toggleLabel = computed(() =>
  labelFor('toggle', `${verb.value}监控`, `正在${verb.value}…`, `重试${verb.value}`));
const addLabel = computed(() =>
  labelFor('add', '重新添加监控', '正在重新添加…', '重试重新添加'));
const saveLabel = computed(() =>
  labelFor('save', '保存配置', '正在保存…', '重试保存'));
const deleteLabel = computed(() =>
  labelFor('delete', '删除监控配置', '正在删除…', '重试删除'));

function editMode(value: string | number | boolean | undefined): void {
  if (value !== 'recent' && value !== 'specified') return;
  mode.value = value;
  notice.value = null;
}

function editRecentN(value: string): void {
  recentN.value = value;
  notice.value = null;
}

function draftRecentN(): number | null {
  if (!/^[1-9][0-9]*$/.test(recentN.value)) return null;
  const value = Number(recentN.value);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

async function write<T>(
  action: Action,
  operation: (signal: AbortSignal) => Promise<ManagementResult<T>>,
  succeed: (data: T) => void,
  successText?: string,
): Promise<void> {
  if (busy.value) return;
  notice.value = null;
  pending.value = action;
  const result = await props.requests.run(props.up.uid, operation);
  // 已取消、离开页面或属于别的写入：迟到结果不改写当前卡片。
  if (!result) return;
  pending.value = null;
  if (result.status === 'success') {
    succeed(result.data);
    if (successText) notice.value = { error: false, text: successText, action };
  } else if (result.status === 'error') {
    notice.value = { error: true, text: result.message, action };
  }
}

function toggle(): Promise<void> {
  const monitor = props.up.monitor;
  if (!monitor) return Promise.resolve();
  return write('toggle', signal => management.updateMonitor({
    uid: props.up.uid, monitor: { mode: monitor.mode, recentN: monitor.recentN, enabled: !monitor.enabled }, signal,
  }), next => emit('change', next), '启停已保存。');
}

function save(): Promise<void> {
  const monitor = props.up.monitor;
  if (!monitor) return Promise.resolve();
  const n = draftRecentN();
  if (n === null) {
    notice.value = { error: true, text: invalidRecentNMessage, action: 'save' };
    return Promise.resolve();
  }
  return write('save', signal => management.updateMonitor({
    uid: props.up.uid, monitor: { mode: mode.value, recentN: n, enabled: monitor.enabled }, signal,
  }), next => emit('change', next), '保存成功。');
}

function reAdd(): Promise<void> {
  if (props.up.monitor) return Promise.resolve();
  return write('add', signal => management.addUp({ uid: props.up.uid, signal }),
    next => emit('change', next));
}

function remove(): Promise<void> {
  if (!props.up.monitor) return Promise.resolve();
  return write('delete', signal => management.deleteMonitor({ uid: props.up.uid, signal }),
    () => emit('change', { ...props.up, monitor: null }));
}
</script>

<template>
  <article class="manage-up" :aria-label="`UP ${up.uid}`" :aria-busy="busy">
    <header class="manage-identity">
      <UserAvatar :user="user" :size="56" />
      <div class="manage-identity-text">
        <h2 class="manage-author">{{ user.nickname ?? '未知用户' }}</h2>
        <p class="manage-muted">UID：{{ up.uid }}</p>
      </div>
      <span class="manage-badge">{{ status }}</span>
    </header>
    <div class="manage-control-row">
      <p class="manage-state">监控：{{ monitorText }}</p>
      <el-button v-if="up.monitor" class="manage-toggle" :disabled="busy" @click="toggle()">
        {{ toggleLabel }}
      </el-button>
      <el-button v-else class="manage-toggle" :disabled="busy" @click="reAdd()">
        {{ addLabel }}
      </el-button>
    </div>
    <el-alert
      v-if="notice"
      class="manage-feedback"
      :title="notice.text"
      :type="notice.error ? 'error' : 'success'"
      :closable="false"
      show-icon
    />

    <section class="manage-section" aria-label="监控配置">
      <h2 class="manage-section-title">监控配置</h2>
      <template v-if="up.monitor">
        <p class="manage-state">{{ savedModeText }}</p>
        <p class="manage-muted">启停立即生效，使用已保存配置，不会保存下方草稿。</p>
        <el-form class="manage-config" aria-label="监控配置草稿" @submit.prevent="save">
          <fieldset class="manage-fields" :disabled="busy">
            <el-form-item label="监控模式">
              <el-radio-group :model-value="mode" aria-label="监控模式" @update:model-value="editMode">
                <el-radio value="recent">近期 N 条</el-radio>
                <el-radio value="specified">指定动态 ID</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item v-if="mode === 'recent'" label="近期 N 条">
              <el-input
                :model-value="recentN"
                inputmode="numeric"
                autocomplete="off"
                :disabled="busy"
                @update:model-value="editRecentN"
              />
            </el-form-item>
            <el-button type="primary" native-type="submit" class="manage-save" :disabled="busy">
              {{ saveLabel }}
            </el-button>
          </fieldset>
        </el-form>
        <p v-if="mode === 'specified'" class="manage-muted">保存指定模式后仅监控下方关联目标；不附加近期动态。</p>
      </template>
      <p v-else class="manage-muted">暂无监控配置，重新添加后可编辑。</p>
    </section>

    <ManageTargets
      v-if="up.monitor && mode === 'specified'"
      :key="up.uid"
      :uid="up.uid"
      :requests="requests"
    />
    <section v-else class="manage-section" aria-label="指定动态目标">
      <h2 class="manage-section-title">指定动态目标</h2>
      <p class="manage-muted">{{ targetHint }}</p>
    </section>

    <footer class="manage-section manage-footer">
      <template v-if="up.monitor">
        <el-button class="manage-delete" :disabled="busy" @click="remove()">{{ deleteLabel }}</el-button>
        <span class="manage-muted">仅删除配置，保留身份和已有归档。</span>
      </template>
      <p v-else class="manage-muted">监控配置已删除；身份和已有归档保留。</p>
    </footer>
  </article>
</template>

<style scoped>
.manage-up {
  padding: 16px;
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}

.manage-identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.manage-identity-text {
  flex: 1;
  min-width: 0;
}

.manage-author {
  margin: 0;
  font-size: 16px;
  color: var(--author);
  overflow-wrap: anywhere;
}

.manage-badge {
  flex: none;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--brand-strong);
  font-size: 12px;
  white-space: nowrap;
}

.manage-control-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}

.manage-state {
  margin: 0;
}

.manage-toggle,
.manage-save,
.manage-delete {
  min-height: var(--touch);
}

.manage-config {
  margin-top: 12px;
}

.manage-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.manage-footer .manage-muted {
  margin: 0;
}

@media (max-width: 640px) {
  .manage-toggle,
  .manage-save,
  .manage-delete {
    width: 100%;
  }
}
</style>
