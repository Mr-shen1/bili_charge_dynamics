<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput } from 'element-plus';
import { useSession } from '../app/session';
import UserAvatar from '../dynamics/UserAvatar.vue';
import { invalidUidMessage, isValidUid, type ManagedUp } from './managementApi';
import { manageStatus, manageUser } from './status';
import { useManagementRead } from './useManagementRead';
import { useManagementRequests } from './useManagementRequests';

// 列表页只展示身份与监控状态；配置、目标与检查状态在单 UP 页。
const { management } = useSession();
const { ups, state: readState, error: readError, reload } = useManagementRead(signal =>
  management.listUps({ signal }));
const { busyUids, run } = useManagementRequests();

const uid = ref('');
const addNotice = ref<{ error: boolean; text: string } | null>(null);
const adding = computed(() => busyUids.value.has(uid.value));

function replaceUp(up: ManagedUp): void {
  const existing = ups.value.find(item => item.uid === up.uid);
  if (existing) {
    ups.value = ups.value.map(item => item.uid === up.uid ? up : item);
    return;
  }
  ups.value = [...ups.value, up].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
}

async function add(): Promise<void> {
  if (readState.value !== 'ready' || adding.value) return;
  if (!isValidUid(uid.value)) {
    addNotice.value = { error: true, text: invalidUidMessage };
    return;
  }
  addNotice.value = null;
  const submitted = uid.value;
  const result = await run(submitted, signal => management.addUp({ uid: submitted, signal }));
  // 请求在防重锁外被取消或属于已离开的访问：不改写当前页面。
  if (!result) return;
  if (result.status === 'success') {
    replaceUp(result.data);
    uid.value = '';
    addNotice.value = { error: false, text: '添加成功。' };
  } else if (result.status === 'error') {
    addNotice.value = { error: true, text: result.message };
  }
}

function editUid(value: string): void {
  uid.value = value;
  addNotice.value = null;
}
</script>

<template>
  <div class="manage-visit">
    <p v-if="readState === 'loading'" class="manage-notice" role="status">正在读取管理配置…</p>
    <div v-else-if="readState === 'error'" class="manage-notice">
      <el-alert :title="readError" type="error" :closable="false" show-icon />
      <el-button type="primary" class="manage-retry" @click="reload()">重新读取</el-button>
    </div>
    <template v-else>
      <el-form class="manage-add" aria-label="添加 UP" @submit.prevent="add">
        <el-form-item label="UP UID">
          <el-input
            :model-value="uid"
            inputmode="numeric"
            autocomplete="off"
            aria-describedby="manage-uid-help"
            :disabled="adding"
            @update:model-value="editUid"
          />
        </el-form-item>
        <el-button type="primary" native-type="submit" class="manage-submit" :disabled="adding">
          {{ adding ? '正在添加…' : addNotice?.error ? '重试添加' : '添加监控' }}
        </el-button>
      </el-form>
      <p id="manage-uid-help" class="manage-muted">仅输入 UID，由服务端取得昵称与头像；不编辑身份或凭据。</p>
      <el-alert
        v-if="addNotice"
        class="manage-feedback"
        :title="addNotice.text"
        :type="addNotice.error ? 'error' : 'success'"
        :closable="false"
        show-icon
      />
      <p v-if="ups.length === 0" class="manage-notice" role="status">尚未保存 UP，请输入 UID 添加。</p>
      <ul v-else class="manage-ups" aria-label="UP 列表">
        <li v-for="up in ups" :key="up.uid">
          <RouterLink
            class="manage-up-link"
            :to="{ name: 'manage-up', params: { upId: up.uid } }"
            :aria-label="`管理 UP ${up.uid}`"
          >
            <UserAvatar :user="manageUser(up)" :size="40" decorative />
            <span class="manage-up-text">
              <span class="manage-author">{{ manageUser(up).nickname ?? '未知用户' }}</span>
              <span class="manage-muted">UID：{{ up.uid }}</span>
            </span>
            <span class="manage-badge">{{ manageStatus(up) }}</span>
          </RouterLink>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.manage-visit {
  min-width: 0;
}

.manage-notice {
  margin: 0 0 16px;
  padding: 16px;
  color: var(--muted);
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.manage-submit,
.manage-retry {
  min-height: var(--touch);
}

.manage-muted {
  margin-top: 8px;
}

.manage-ups {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
}

.manage-up-link {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: var(--touch);
  padding: 12px 16px;
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: inherit;
  text-decoration: none;
}

.manage-up-link:focus-visible {
  outline: 3px solid var(--brand);
  outline-offset: 2px;
}

.manage-up-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.manage-author {
  font-weight: 600;
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

@media (max-width: 640px) {
  .manage-submit {
    width: 100%;
  }
}
</style>
