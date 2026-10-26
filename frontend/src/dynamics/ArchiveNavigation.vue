<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElButton } from 'element-plus';
import type { ArchiveScope, ReadStatus, User } from '../data/contracts';
import { useSession } from '../app/session';
import UserAvatar from './UserAvatar.vue';

interface ReadUpsState {
  readonly status: ReadStatus;
  readonly data: readonly User[];
}

const props = defineProps<{ scope: ArchiveScope }>();
const { reader } = useSession();
const state = ref<ReadUpsState>({ status: 'loading', data: [] });
const attempt = ref(0);
let controller: AbortController | null = null;
let active = false;

function read(): void {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  state.value = { status: 'loading', data: [] };
  active = true;
  void reader.readUps({ signal: current.signal }).then(result => {
    if (!active || current.signal.aborted) return;
    state.value = result.status === 'success'
      ? { status: 'success', data: result.data }
      : { status: result.status, data: [] };
  }).catch(() => {
    if (active && !current.signal.aborted) state.value = { status: 'error', data: [] };
  });
}

onMounted(read);
watch(attempt, () => { read(); });
onBeforeUnmount(() => {
  active = false;
  controller?.abort();
  controller = null;
});

function selected(userId: string): boolean {
  return props.scope.kind === 'up' && props.scope.upId === userId;
}
</script>

<template>
  <nav class="archive-nav" aria-label="归档范围">
    <ul class="up-strip">
      <li>
        <RouterLink
          class="up-option"
          :class="{ selected: scope.kind === 'all' }"
          to="/"
          :aria-current="scope.kind === 'all' ? 'page' : undefined"
          title="全部归档"
        >
          <span class="up-option__all" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M16 16V5c-8-3-11 8 0 11h11c3-8-8-11-11 0v11c8 3 11-8 0-11H5c-3 8 8 11 11 0Z" />
            </svg>
          </span>
          <span class="up-option__nickname">全部归档</span>
        </RouterLink>
      </li>
      <li v-for="user in state.data" :key="user.id">
        <RouterLink
          class="up-option"
          :class="{ selected: selected(user.id) }"
          :to="`/ups/${encodeURIComponent(user.id)}`"
          :aria-current="selected(user.id) ? 'page' : undefined"
          :title="user.nickname ?? '未知用户'"
        >
          <UserAvatar :user="user" :size="32" decorative class="up-option__avatar" />
          <span class="up-option__nickname">{{ user.nickname ?? '未知用户' }}</span>
        </RouterLink>
      </li>
    </ul>
    <p v-if="state.status === 'loading'" class="archive-nav__notice" role="status">UP 身份列表加载中…</p>
    <div v-else-if="state.status !== 'success'" class="archive-nav__notice" role="status">
      <span>{{ state.status === 'cancelled' ? 'UP 身份列表读取已取消。' : 'UP 身份列表读取失败。' }}</span>
      <el-button type="primary" link class="archive-nav__retry" @click="attempt += 1">重读 UP 列表</el-button>
    </div>
  </nav>
</template>

<style scoped>
.archive-nav {
  min-width: 0;
  max-width: 100%;
  margin: 0 0 8px;
}
.up-strip {
  display: flex;
  gap: 8px;
  list-style: none;
  margin: 0;
  padding: 2px 0 6px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}
.up-strip > li {
  flex: 0 0 auto;
  min-width: 0;
}
.up-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 200px;
  min-height: var(--touch);
  padding: 0 10px;
  border-radius: var(--radius);
  color: var(--muted);
  text-decoration: none;
}
.up-option.selected {
  background: var(--el-color-primary-light-9);
  color: var(--brand-strong);
  font-weight: 600;
}
.up-option:focus-visible {
  outline: 3px solid var(--brand);
  outline-offset: 2px;
}
.up-option__avatar {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
}
.up-option__all {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--el-color-primary-light-8);
  color: var(--brand-strong);
}
.up-option__all svg {
  width: 20px;
  height: 20px;
}
.up-option__nickname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.archive-nav__notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0 4px;
  color: var(--muted);
  font-size: 13px;
  line-height: 20px;
}
.archive-nav__retry {
  min-height: var(--touch);
}
</style>
