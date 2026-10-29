<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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

const strip = ref<HTMLElement | null>(null);
let observer: ResizeObserver | null = null;
let frame = 0;

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

/**
 * 单排横滑的 UP 条：屏幕外的长昵称不应把整排撑出空白，滑到它时又要能读全。
 * 因此只让当前可见的选项按完整换行占高，屏幕外的选项收成一行（文字仍在可访问树里），
 * 越过边界就重新判断——不裁字、不省略，也不靠固定高度猜一个上限。
 */
function measure(): void {
  const element = strip.value;
  if (!element) return;
  const box = element.getBoundingClientRect();
  // 不可测量时（未布局、被隐藏）保持自然高度，不做半套裁剪。
  if (box.width <= 0) return;
  for (const option of element.querySelectorAll<HTMLElement>('.up-option')) {
    const rect = option.getBoundingClientRect();
    const visible = rect.right > box.left + 1 && rect.left < box.right - 1;
    option.classList.toggle('up-option--offscreen', !visible);
  }
}

function schedule(): void {
  if (typeof requestAnimationFrame !== 'function') {
    measure();
    return;
  }
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    measure();
  });
}

onMounted(() => {
  read();
  measure();
  if (typeof ResizeObserver !== 'undefined' && strip.value) {
    observer = new ResizeObserver(schedule);
    observer.observe(strip.value);
  }
});
watch(attempt, () => { read(); });
// 身份列表落地后重新判断可见性：新选项的昵称长度不同，整排高度随之变化。
watch(() => state.value.data, () => { void nextTick(schedule); });
onBeforeUnmount(() => {
  active = false;
  controller?.abort();
  controller = null;
  observer?.disconnect();
  observer = null;
  if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  frame = 0;
});

function selected(userId: string): boolean {
  return props.scope.kind === 'up' && props.scope.upId === userId;
}
</script>

<template>
  <nav class="archive-nav" aria-label="动态范围">
    <ul ref="strip" class="up-strip" @scroll.passive="schedule">
      <li>
        <RouterLink
          class="up-option"
          :class="{ selected: scope.kind === 'all' }"
          to="/"
          :aria-current="scope.kind === 'all' ? 'page' : undefined"
          title="全部动态"
        >
          <span class="up-option__all" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M16 16V5c-8-3-11 8 0 11h11c3-8-8-11-11 0v11c8 3 11-8 0-11H5c-3 8 8 11 11 0Z" />
            </svg>
          </span>
          <span class="up-option__nickname">全部动态</span>
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
          <UserAvatar :user="user" :size="48" decorative class="up-option__avatar" />
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
/* 可见昵称底部至第一张卡片约 12px；整排高度由可见项决定，见 script 的 measure()。 */
.archive-nav {
  min-width: 0;
  max-width: 100%;
  margin: 0 0 12px;
}
.up-strip {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  /* 头像条可横滑但不显示滚动条（触屏、触控板与键盘仍可移动）。 */
  scrollbar-width: none;
}
.up-strip::-webkit-scrollbar {
  display: none;
}
.up-strip > li {
  flex: 0 0 auto;
  min-width: 0;
}
/* 上图下字：头像与图标 48px，文字容器同宽并完整换行。 */
.up-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 48px;
  min-height: var(--touch);
  padding: 0 0 4px;
  border-radius: var(--radius);
  color: var(--muted);
  text-align: center;
  text-decoration: none;
}
.up-option.selected {
  color: var(--action);
  font-weight: 600;
}
.up-option.selected .up-option__avatar,
.up-option.selected .up-option__all {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.up-option:focus-visible {
  outline: 3px solid var(--brand);
  outline-offset: 2px;
}
.up-option__avatar {
  flex: 0 0 48px;
  width: 48px;
  height: 48px;
}
.up-option__all {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 48px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--el-color-primary-light-8);
  color: var(--brand-strong);
}
.up-option__all svg {
  width: 26px;
  height: 26px;
}
.up-option__nickname {
  width: 48px;
  font-size: var(--font-up-nickname);
  line-height: var(--line-up-nickname);
  white-space: normal;
  overflow-wrap: anywhere;
}
/* 屏幕外的选项只占一行高度（文字仍在可访问树里），滑到可见处立即恢复完整换行。 */
.up-option--offscreen .up-option__nickname {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  overflow: hidden;
}
.archive-nav__notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 4px 0 0;
  color: var(--muted);
  font-size: var(--font-meta);
  line-height: var(--line-meta);
}
.archive-nav__retry {
  min-height: var(--touch);
  font-size: var(--font-link);
}
</style>
